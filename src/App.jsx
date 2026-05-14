import { useState, useReducer, useCallback } from "react";

// ─── System prompt (verbatim from spec) ───────────────────────────────────────

const SYSTEM_PROMPT = `You are a crux-finding engine. Your sole job is to read someone's reasoning about a decision and find what their conclusion actually depends on.

Analyze the input. Classify every distinct claim into one of four epistemic types:
- FACT: something verifiable and verified. They actually know this.
- INFERENCE: a conclusion drawn from other things they believe. May be valid or not.
- PRIOR: a background belief or assumption they're bringing in. Not argued for, just assumed.
- VIBE: a feeling, intuition, or emotional state dressed as a reason.

Then find the CRUX: the single assumption that is both (a) most load-bearing — if it's false, the conclusion collapses — and (b) least examined — they've asserted it without evidence or scrutiny.

Then produce exactly ONE question. Not a list. One. The sharpest question that, if they sat with it honestly, would most change their decision.

Respond ONLY with XML in exactly this structure, no text before or after:

<analysis>
  <claims>
    <claim>
      <type>FACT|INFERENCE|PRIOR|VIBE</type>
      <text>The extracted claim, in their words or close to it</text>
      <unexamined>0 to 100, where 100 means completely unexamined</unexamined>
      <note>One sentence: why this type, why this score</note>
    </claim>
  </claims>
  <crux>
    <text>The single most load-bearing unexamined assumption, stated plainly</text>
    <why>One or two sentences: what flips if this assumption is wrong</why>
  </crux>
  <question>
    Exactly one question. Sharp. The one they most need to answer before acting.
  </question>
</analysis>

Rules:
- Extract 3 to 7 claims. Not more.
- The crux must be one of the claims, or a hidden assumption implied by them.
- The question must be answerable in principle — not rhetorical.
- Never produce more than one question.
- Never add prose outside the XML tags.`;

// ─── XML parser (regex-based, forgiving of messy model output) ──────────────

function parseAnalysis(raw) {
  // Strip markdown fences and trim
  const cleaned = raw
    .replace(/```xml/gi, '')
    .replace(/```/g, '')
    .trim();

  // Helper: extract first match content between exact open/close tags
  function extract(str, tag) {
    // Exact tag match — won't match <claims> when looking for <claim>
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = str.match(re);
    return m ? m[1].trim() : '';
  }

  // Helper: greedy extract — for when output is truncated and closing tag may be missing
  function extractGreedy(str, tag) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*)`, 'i');
    const m = str.match(re);
    if (!m) return '';
    // Try to find the closing tag; if missing, take everything
    const content = m[1];
    const closeIdx = content.search(new RegExp(`</${tag}>`, 'i'));
    return closeIdx >= 0 ? content.substring(0, closeIdx).trim() : content.trim();
  }

  // Helper: extract ALL matches of an exact block tag
  function extractAll(str, tag) {
    const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
    const results = [];
    let m;
    while ((m = regex.exec(str)) !== null) {
      results.push(m[1].trim());
    }
    return results;
  }

  // ── Extract claims (exact <claim>, not <claims>) ──
  const claimBlocks = extractAll(cleaned, 'claim');
  const claims = claimBlocks.map(block => ({
    type: (extract(block, 'type') || 'PRIOR').toUpperCase(),
    text: extract(block, 'text') || '',
    unexamined: parseInt(extract(block, 'unexamined') || '50', 10),
    note: extract(block, 'note') || ''
  })).filter(c => c.text.length > 0);

  // ── Extract crux (with truncation fallback) ──
  let cruxRaw = extract(cleaned, 'crux') || extractGreedy(cleaned, 'crux');
  let cruxText = extract(cruxRaw, 'text');
  let cruxWhy = extract(cruxRaw, 'why');

  // Fallback: if nested tags missing, use greedy extraction
  if (!cruxText) cruxText = extractGreedy(cruxRaw, 'text');
  // Fallback: if still no <text>, strip all tags and use raw content
  if (!cruxText && cruxRaw) {
    const stripped = cruxRaw.replace(/<[^>]*>/g, '').trim();
    if (stripped) cruxText = stripped;
  }
  if (!cruxWhy) cruxWhy = extractGreedy(cruxRaw, 'why');

  const crux = { text: cruxText, why: cruxWhy };

  // ── Extract question (with truncation fallback) ──
  let question = extract(cleaned, 'question') || extractGreedy(cleaned, 'question');

  // Fallback: grab any question-like text after </crux>
  if (!question) {
    const afterCrux = cleaned.split(/<\/crux>/i)[1] || '';
    const candidate = afterCrux.replace(/<[^>]*>/g, '').trim();
    if (candidate && candidate.includes('?')) {
      question = candidate;
    }
  }

  // Clean up any stray tags from truncated output
  if (question) question = question.replace(/<[^>]*>/g, '').trim();
  if (crux.why) crux.why = crux.why.replace(/<[^>]*>/g, '').trim();

  if (claims.length === 0 || !crux.text || !question) {
    console.error('Parse failed. Cleaned XML was:', cleaned);
    throw new Error('Incomplete parse: ' + JSON.stringify({
      claims: claims.length,
      crux: crux.text ? crux.text.substring(0, 50) : '',
      question: question ? question.substring(0, 50) : '',
      rawLength: cleaned.length
    }));
  }

  return { claims, crux, question };
}

// ─── Test Suite ────────────────────────────────────────────────────────────────

const parserTestCases = [
  {
    label: "Clean valid XML",
    input: `<analysis>
      <claims>
        <claim><type>FACT</type><text>I have savings</text><unexamined>10</unexamined><note>Stated directly</note></claim>
        <claim><type>PRIOR</type><text>The market exists</text><unexamined>80</unexamined><note>Assumed without evidence</note></claim>
      </claims>
      <crux><text>The market exists</text><why>If wrong, the entire plan collapses</why></crux>
      <question>Have you spoken to 10 potential paying customers?</question>
    </analysis>`,
    shouldPass: true
  },
  {
    label: "XML wrapped in markdown fences",
    input: "```xml\n<analysis><claims><claim><type>FACT</type><text>I have savings</text><unexamined>10</unexamined><note>Stated</note></claim></claims><crux><text>Market exists</text><why>Core assumption</why></crux><question>Have you validated this?</question></analysis>\n```",
    shouldPass: true
  },
  {
    label: "Prose before and after XML",
    input: `Sure! Here is my analysis:\n<analysis><claims><claim><type>VIBE</type><text>Timing feels right</text><unexamined>90</unexamined><note>Pure feeling</note></claim></claims><crux><text>Timing feels right</text><why>Drives urgency</why></crux><question>What data supports this timing?</question></analysis>\nI hope this helps!`,
    shouldPass: true
  },
  {
    label: "Special characters inside text nodes",
    input: `<analysis><claims><claim><type>INFERENCE</type><text>My manager's skepticism isn't valid & he's risk-averse</text><unexamined>70</unexamined><note>Dismisses valid concern</note></claim></claims><crux><text>Manager's view doesn't matter</text><why>If wrong, key feedback ignored</why></crux><question>Has your manager's concern ever been right before?</question></analysis>`,
    shouldPass: true
  },
  {
    label: "Missing question tag",
    input: `<analysis><claims><claim><type>FACT</type><text>I have savings</text><unexamined>10</unexamined><note>Direct</note></claim></claims><crux><text>Market exists</text><why>Core</why></crux></analysis>`,
    shouldPass: false
  },
  {
    label: "Empty claims",
    input: `<analysis><claims></claims><crux><text>Something</text><why>Because</why></crux><question>A question?</question></analysis>`,
    shouldPass: false
  },
  {
    label: "Completely empty string",
    input: "",
    shouldPass: false
  },
  {
    label: "Random prose no XML at all",
    input: "I think you should consider your options carefully and weigh the pros and cons.",
    shouldPass: false
  },
  {
    label: "Unexamined score as non-integer",
    input: `<analysis><claims><claim><type>PRIOR</type><text>I trust my cofounder</text><unexamined>high</unexamined><note>Vague</note></claim></claims><crux><text>I trust my cofounder</text><why>Execution depends on this</why></crux><question>Have you worked under pressure together?</question></analysis>`,
    shouldPass: true
  }
];

function runParserTests() {
  let passed = 0;
  let failed = 0;

  console.log("%c LAYER 1: Parser Stress Tests ", "background: #334155; color: #38bdf8; font-weight: bold; padding: 4px 8px; border-radius: 4px;");

  parserTestCases.forEach(({ label, input, shouldPass }) => {
    try {
      const result = parseAnalysis(input);
      if (shouldPass) {
        console.log(`%c ✅ PASS %c ${label}`, "color: #22c55e; font-weight: bold;", "color: inherit;");
        console.log(`   Claims: ${result.claims.length}, Crux: "${result.crux.text.slice(0, 40)}...", Question: present`);
        passed++;
      } else {
        console.warn(`%c ❌ FAIL %c (should have thrown): ${label}`, "color: #ef4444; font-weight: bold;", "color: inherit;");
        failed++;
      }
    } catch (e) {
      if (!shouldPass) {
        console.log(`%c ✅ PASS %c (correctly rejected): ${label}`, "color: #22c55e; font-weight: bold;", "color: inherit;");
        passed++;
      } else {
        console.warn(`%c ❌ FAIL %c (should have passed): ${label} — ${e.message}`, "color: #ef4444; font-weight: bold;", "color: inherit;");
        failed++;
      }
    }
  });

  const allPassed = failed === 0;
  console.log(`\n%c Parser: ${passed} passed, ${failed} failed out of ${parserTestCases.length} %c ${allPassed ? "✅ ALL CLEAR" : "⚠️ FIX NEEDED"}`,
    "font-weight: bold;", allPassed ? "color: #22c55e;" : "color: #ef4444;");
  return allPassed;
}

const consistencyTestPrompts = [
  "I should quit my job and start a company. The timing is right and I have savings.",
  "I am confused whether to accept a job offer or keep hunting. The offer has a 3 year bond.",
  "I want to do M.Tech from IIT but I am not sure if I am smart enough.",
  "I should move to Bangalore for better opportunities. My family is against it.",
  "I think my startup idea is good but nobody has built it yet which means either it's brilliant or it's a bad idea."
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RATE_LIMIT_DELAY_MS = 12000; // 12s between test API calls for Groq free tier

async function callWithRetry(apiKey, groqApiKey, groqModel, messages, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM(messages, apiKey, groqApiKey, groqModel);
    } catch (e) {
      const isRateLimit = e.message?.includes('429') || e.message?.includes('rate_limit');
      if (isRateLimit && attempt < maxRetries) {
        const waitTime = RATE_LIMIT_DELAY_MS * (attempt + 1);
        console.log(`    ⏳ Rate limited — waiting ${waitTime / 1000}s before retry...`);
        await sleep(waitTime);
        continue;
      }
      throw e;
    }
  }
}

async function runConsistencyTests(apiKey, groqApiKey, groqModel) {
  const RUNS_PER_PROMPT = 3;
  let totalRuns = 0;
  let totalPassed = 0;
  let rateLimited = 0;

  console.log("%c LAYER 2: Model Output Consistency ", "background: #334155; color: #a78bfa; font-weight: bold; padding: 4px 8px; border-radius: 4px;");

  if (!apiKey && !groqApiKey) {
    console.warn("⚠️ No API key provided — skipping consistency tests.");
    return false;
  }

  for (const prompt of consistencyTestPrompts) {
    let promptPassed = 0;
    console.log(`\n  Testing: "${prompt.slice(0, 60)}..."`);

    for (let i = 0; i < RUNS_PER_PROMPT; i++) {
      if (i > 0 || totalRuns > 0) {
        console.log(`    ⏳ Waiting ${RATE_LIMIT_DELAY_MS / 1000}s (rate limit)...`);
        await sleep(RATE_LIMIT_DELAY_MS);
      }
      try {
        const raw = await callWithRetry(apiKey, groqApiKey, groqModel, [{ role: "user", content: prompt }]);
        parseAnalysis(raw);
        console.log(`    Run ${i + 1}: %c✅ Parseable`, "color: #22c55e;");
        promptPassed++;
      } catch (e) {
        const isRateLimit = e.message?.includes('429') || e.message?.includes('rate_limit');
        if (isRateLimit) {
          console.warn(`    Run ${i + 1}: %c⚠️ Rate limited%c (not a parse failure)`, "color: #f59e0b;", "color: inherit;");
          rateLimited++;
        } else {
          console.warn(`    Run ${i + 1}: %c❌ Failed%c — ${e.message}`, "color: #ef4444;", "color: inherit;");
        }
      }
      totalRuns++;
    }

    totalPassed += promptPassed;
    console.log(`    Result: ${promptPassed}/${RUNS_PER_PROMPT}`);
  }

  const validRuns = totalRuns - rateLimited;
  const rate = validRuns > 0 ? Math.round(totalPassed / validRuns * 100) : 0;
  const ok = rate >= 90;
  console.log(`\n%c Consistency: ${totalPassed}/${validRuns} parseable (${rate}%) %c ${ok ? "✅ ABOVE 90%" : "⚠️ BELOW 90% — system prompt needs strengthening"}`,
    "font-weight: bold;", ok ? "color: #22c55e;" : "color: #ef4444;");
  if (rateLimited > 0) {
    console.log(`  (${rateLimited} runs skipped due to rate limiting — not counted as failures)`);
  }
  return ok;
}

const cruxQualityTestCases = [
  {
    input: "I should leave my job and start a company. The market is there. I have savings. My co-founder is reliable. I've been thinking about this for two years.",
    expectedCruxKeywords: ["co-founder", "reliable", "trust", "market"],
    notes: "Real crux is co-founder reliability or market assumption"
  },
  {
    input: "I have a job offer with a 3 year bond at 5LPA. I want to do M.Tech from IIT. I am interested in research.",
    expectedCruxKeywords: ["research", "interest", "bond", "GATE", "IIT"],
    notes: "Real crux is whether research interest is genuine or assumed"
  },
  {
    input: "I should move cities for a better job. My salary will double. My family is against it. I can handle being alone.",
    expectedCruxKeywords: ["alone", "family", "handle", "salary"],
    notes: "Real crux is whether they can actually handle isolation"
  }
];

async function runCruxQualityTests(apiKey, groqApiKey, groqModel) {
  console.log("%c LAYER 3: Crux Quality Tests (Human Review) ", "background: #334155; color: #fbbf24; font-weight: bold; padding: 4px 8px; border-radius: 4px;");

  if (!apiKey && !groqApiKey) {
    console.warn("⚠️ No API key provided — skipping crux quality tests.");
    return;
  }

  for (let idx = 0; idx < cruxQualityTestCases.length; idx++) {
    const { input, expectedCruxKeywords, notes } = cruxQualityTestCases[idx];
    if (idx > 0) {
      console.log(`  ⏳ Waiting ${RATE_LIMIT_DELAY_MS / 1000}s (rate limit)...`);
      await sleep(RATE_LIMIT_DELAY_MS);
    }
    try {
      const raw = await callWithRetry(apiKey, groqApiKey, groqModel, [{ role: "user", content: input }]);
      const result = parseAnalysis(raw);

      const cruxText = result.crux.text.toLowerCase();
      const matched = expectedCruxKeywords.filter(k => cruxText.includes(k.toLowerCase()));
      const qualityScore = Math.round((matched.length / expectedCruxKeywords.length) * 100);

      console.log(`\n  Input: "${input.slice(0, 60)}..."`);
      console.log(`  Crux found: %c"${result.crux.text}"`, "color: #f87171; font-weight: bold;");
      console.log(`  Why: "${result.crux.why}"`);
      console.log(`  Question: %c"${result.question}"`, "color: #38bdf8;");
      console.log(`  Keyword match: ${matched.length}/${expectedCruxKeywords.length} (${qualityScore}%) — [${matched.join(", ") || "none"}]`);
      console.log(`  Notes: ${notes}`);
      console.log(`  %c👁️ HUMAN REVIEW NEEDED — is this the real crux?`, "color: #fbbf24; font-style: italic;");
    } catch (e) {
      console.warn(`  ❌ Failed for: "${input.slice(0, 40)}..." — ${e.message}`);
    }
  }
}

async function runAllTests(apiKey, groqApiKey, groqModel) {
  console.clear();
  console.log("%c ═══ CRUX ENGINE TEST SUITE ═══ ", "background: #1e293b; color: #f8fafc; font-weight: bold; font-size: 14px; padding: 8px 16px; border-radius: 6px;");
  console.log("");

  const parserOk = runParserTests();
  console.log("");

  const consistencyOk = await runConsistencyTests(apiKey, groqApiKey, groqModel);
  console.log("");

  await runCruxQualityTests(apiKey, groqApiKey, groqModel);
  console.log("");

  console.log("%c ═══ TEST SUITE COMPLETE ═══ ", "background: #1e293b; color: #f8fafc; font-weight: bold; font-size: 14px; padding: 8px 16px; border-radius: 6px;");
  console.log(`  Parser: ${parserOk ? "✅" : "❌"}  |  Consistency: ${consistencyOk ? "✅" : "❌"}  |  Quality: 👁️ review above`);
}

// ─── State reducer ────────────────────────────────────────────────────────────

const GROQ_MODELS = [
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
];

const initialState = {
  mode: "idle", // idle | analyzing | map | error
  input: "",
  followUpInput: "",
  apiKey: "",
  groqApiKey: "",
  groqModel: "llama-3.3-70b-versatile",
  analysis: null,
  conversationHistory: [],
  rawXml: "",
  errorMessage: "",
  isFollowUp: false,
};

function reducer(state, action) {
  switch (action.type) {
    case "SET_INPUT":
      return { ...state, input: action.payload };
    case "SET_API_KEY":
      return { ...state, apiKey: action.payload };
    case "SET_GROQ_API_KEY":
      return { ...state, groqApiKey: action.payload };
    case "SET_GROQ_MODEL":
      return { ...state, groqModel: action.payload };
    case "SET_FOLLOWUP_INPUT":
      return { ...state, followUpInput: action.payload };
    case "START_ANALYZING":
      return {
        ...state,
        mode: "analyzing",
        errorMessage: "",
        isFollowUp: action.payload?.isFollowUp || false,
      };
    case "ANALYSIS_SUCCESS":
      return {
        ...state,
        mode: "map",
        analysis: action.payload.analysis,
        rawXml: action.payload.rawXml,
        conversationHistory: action.payload.conversationHistory,
        followUpInput: "",
        errorMessage: "",
      };
    case "ANALYSIS_ERROR":
      return {
        ...state,
        mode: "error",
        errorMessage: action.payload,
      };
    case "RESET":
      return { ...initialState };
    default:
      return state;
  }
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function callAnthropicAPI(conversationHistory, apiKey) {
  const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  const url = apiKey ? "https://api.anthropic.com/v1/messages" : "/api/anthropic/v1/messages";
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: conversationHistory,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${errBody || response.statusText}`);
  }

  const data = await response.json();
  return data.content?.find((b) => b.type === "text")?.text || "";
}

async function callGroqAPI(conversationHistory, groqApiKey, groqModel) {
  const messagesWithSystem = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: groqModel,
      max_tokens: 1500,
      temperature: 0.3,
      messages: messagesWithSystem,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Groq API error ${response.status}: ${errBody || response.statusText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callLLM(conversationHistory, apiKey, groqApiKey, groqModel) {
  if (apiKey) {
    return callAnthropicAPI(conversationHistory, apiKey);
  }
  if (groqApiKey) {
    return callGroqAPI(conversationHistory, groqApiKey, groqModel);
  }
  throw new Error("Please provide either an Anthropic or Groq API key to continue.");
}

// ─── Rephraser (silent retry helper) ──────────────────────────────────────────

const REPHRASE_SYSTEM = `You are a neutral rephraser. The user was asked a question and gave an answer.
Rewrite their answer in clear, structured, first-person prose.
Remove filler words. Preserve every substantive point they made.
Do not add new information. Do not editorialize.
Return ONLY the rephrased answer text. No explanation, no preamble.`;

async function rephraseUserAnswer(originalAnswer, originalQuestion, apiKey, groqApiKey) {
  const userContent = `Question they were asked: "${originalQuestion}"\n\nTheir answer: "${originalAnswer}"\n\nRephrase their answer clearly.`;
  const messages = [{ role: "user", content: userContent }];

  // Use Anthropic if available, otherwise Groq with a fast model
  if (apiKey) {
    const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    headers["x-api-key"] = apiKey;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: REPHRASE_SYSTEM,
        messages,
      }),
    });
    const data = await response.json();
    return data.content?.find((b) => b.type === "text")?.text?.trim() || originalAnswer;
  }

  if (groqApiKey) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 300,
        temperature: 0.2,
        messages: [{ role: "system", content: REPHRASE_SYSTEM }, ...messages],
      }),
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || originalAnswer;
  }

  return originalAnswer;
}

// ─── Claim type config ────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  FACT: {
    label: "FACT",
    color: "bg-fact/20 text-fact border-fact/30",
    dot: "bg-fact",
  },
  INFERENCE: {
    label: "INFERENCE",
    color: "bg-inference/20 text-inference border-inference/30",
    dot: "bg-inference",
  },
  PRIOR: {
    label: "PRIOR",
    color: "bg-prior/20 text-prior border-prior/30",
    dot: "bg-prior",
  },
  VIBE: {
    label: "VIBE",
    color: "bg-vibe/20 text-vibe border-vibe/30",
    dot: "bg-vibe",
  },
};

function getBarColor(score) {
  if (score <= 35) return "bg-fact";
  if (score <= 65) return "bg-prior";
  return "bg-crux";
}

// ─── Components ───────────────────────────────────────────────────────────────

function Header({ mode, onReset }) {
  return (
    <header className="w-full pt-10 pb-6 px-4 text-center relative">
      <div className="flex items-center justify-center gap-3 mb-2">
        {/* Logo mark */}
        <div className="relative w-9 h-9 flex-shrink-0">
          <div className="absolute inset-0 rounded-full border-2 border-accent/40" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-crux" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-2.5 bg-accent/60 rounded-full" />
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0.5 h-2.5 bg-accent/60 rounded-full" />
          <div className="absolute left-0 top-1/2 -translate-y-1/2 h-0.5 w-2.5 bg-accent/60 rounded-full" />
          <div className="absolute right-0 top-1/2 -translate-y-1/2 h-0.5 w-2.5 bg-accent/60 rounded-full" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-text-primary">
          Crux Engine
        </h1>
      </div>
      <p className="text-text-secondary text-sm sm:text-base font-medium">
        Find what your reasoning actually depends on
      </p>
      {mode !== "idle" && (
        <button
          id="btn-start-over"
          onClick={onReset}
          className="absolute top-4 right-4 sm:top-6 sm:right-6 text-xs font-medium text-text-muted hover:text-text-secondary border border-border-default hover:border-border-subtle rounded-lg px-3 py-1.5 transition-colors cursor-pointer"
        >
          Start over
        </button>
      )}
    </header>
  );
}

function IdleView({ input, onInputChange, onSubmit, validationError, apiKey, onApiKeyChange, groqApiKey, onGroqApiKeyChange, groqModel, onGroqModelChange }) {
  return (
    <div className="animate-fade-in w-full max-w-2xl mx-auto px-4">
      <div className="relative mt-4">
        <textarea
          id="input-reasoning"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Describe a decision you're facing or a belief you hold. Write how you'd explain it to a friend — messy is fine."
          className="w-full min-h-[160px] sm:min-h-[200px] bg-surface-raised border border-border-default rounded-2xl p-5 text-text-primary text-base leading-relaxed placeholder:text-text-muted resize-y focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
          autoFocus
        />
        {validationError && (
          <p className="mt-2 text-crux text-sm font-medium">{validationError}</p>
        )}
      </div>
      <div className="mt-5 flex justify-end">
        <button
          id="btn-find-crux"
          onClick={onSubmit}
          className="group relative px-6 py-3 bg-accent hover:bg-accent/90 text-white font-semibold rounded-xl transition-all shadow-lg shadow-accent-glow hover:shadow-xl hover:shadow-accent-glow cursor-pointer"
        >
          <span className="flex items-center gap-2">
            Find the crux
            <svg
              className="w-4 h-4 transition-transform group-hover:translate-x-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
          </span>
        </button>
      </div>

      {/* API Key inputs */}
      <div className="mt-8 bg-surface-raised border border-border-subtle rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <svg className="w-3.5 h-3.5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
          </svg>
          <span className="text-text-secondary text-xs font-semibold tracking-wide uppercase">API Key</span>
        </div>

        {/* Anthropic */}
        <div className="mb-3">
          <label htmlFor="input-api-key" className="text-text-secondary text-xs font-medium block mb-1">Anthropic <span className="text-text-muted font-normal">(Claude Sonnet)</span></label>
          <input
            id="input-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="sk-ant-..."
            className="w-full bg-surface-elevated border border-border-subtle rounded-lg px-3.5 py-2 text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all font-mono"
          />
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3 my-3">
          <div className="flex-1 h-px bg-border-subtle" />
          <span className="text-text-muted text-[11px] font-medium">OR</span>
          <div className="flex-1 h-px bg-border-subtle" />
        </div>

        {/* Groq */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="input-groq-key" className="text-text-secondary text-xs font-medium">Groq <span className="text-fact text-[10px] font-bold ml-1">FREE</span></label>
          </div>

          {/* Model selector */}
          <div className="flex rounded-lg bg-surface-elevated border border-border-subtle mb-2.5 p-0.5">
            {GROQ_MODELS.map((m) => (
              <button
                key={m.id}
                id={`btn-model-${m.id}`}
                onClick={() => onGroqModelChange(m.id)}
                className={`flex-1 px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all cursor-pointer ${
                  groqModel === m.id
                    ? "bg-accent/20 text-accent border border-accent/30"
                    : "text-text-muted hover:text-text-secondary border border-transparent"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <input
            id="input-groq-key"
            type="password"
            value={groqApiKey}
            onChange={(e) => onGroqApiKeyChange(e.target.value)}
            placeholder="gsk_..."
            className="w-full bg-surface-elevated border border-border-subtle rounded-lg px-3.5 py-2 text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all font-mono"
          />
          <p className="text-text-muted text-[11px] mt-1.5">Get a free key at <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">console.groq.com/keys</a></p>
        </div>

        <p className="text-text-muted text-[11px] mt-3 pt-3 border-t border-border-subtle">Keys stay in memory only — never stored or sent anywhere except the chosen API.</p>
      </div>

      {/* Subtle hints */}
      <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
        {[
          { step: "01", label: "You state a belief", sub: "Natural language. Messy as you always are is fine." },
          { step: "02", label: "AI dissects the structure", sub: "Separates facts, inferences, priors, and vibes." },
          { step: "03", label: "Surfaces the crux", sub: "One question. The one you most need to answer." },
        ].map((item) => (
          <div
            key={item.step}
            className="p-4 rounded-xl border border-border-subtle"
          >
            <div className="text-accent font-bold text-xs mb-1.5">
              {item.step}
            </div>
            <div className="text-text-primary text-sm font-semibold mb-1">
              {item.label}
            </div>
            <div className="text-text-muted text-xs leading-relaxed">
              {item.sub}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyzingView({ input, isFollowUp }) {
  return (
    <div className="animate-fade-in w-full max-w-2xl mx-auto px-4 mt-4">
      {/* Show original input */}
      <div className="bg-surface-raised border border-border-subtle rounded-2xl p-5 mb-8">
        <p className="text-text-muted text-sm leading-relaxed whitespace-pre-wrap">
          {input}
        </p>
      </div>

      {/* Loading indicator */}
      <div className="flex flex-col items-center gap-5 py-12">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-2 border-accent/20 animate-crux-pulse" />
          <div className="absolute inset-2 rounded-full border-2 border-accent/40 animate-crux-pulse [animation-delay:0.3s]" />
          <div className="absolute inset-4 rounded-full border-2 border-crux/60 animate-crux-pulse [animation-delay:0.6s]" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-crux animate-crux-pulse [animation-delay:0.9s]" />
        </div>
        <p className="text-text-secondary text-sm font-medium animate-crux-pulse">
          {isFollowUp ? "Re-analyzing with your response..." : "Reading your reasoning..."}
        </p>
      </div>
    </div>
  );
}

function ClaimCard({ claim, index }) {
  const config = TYPE_CONFIG[claim.type] || TYPE_CONFIG.PRIOR;
  const barColor = getBarColor(claim.unexamined);

  return (
    <div className="bg-surface-raised border border-border-subtle rounded-xl p-5 hover:border-border-default transition-colors">
      <div className="flex items-start gap-3">
        {/* Type badge */}
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wider border ${config.color} flex-shrink-0 mt-0.5`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
          {config.label}
        </span>

        <div className="flex-1 min-w-0">
          {/* Claim text */}
          <p className="text-text-primary text-[15px] leading-relaxed">
            {claim.text}
          </p>

          {/* Note */}
          <p className="text-text-muted text-xs mt-2 leading-relaxed">
            {claim.note}
          </p>

          {/* Unexamined bar */}
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${barColor} transition-all duration-700`}
                style={{ width: `${claim.unexamined}%` }}
              />
            </div>
            <span className="text-[11px] font-mono text-text-muted flex-shrink-0 w-24 text-right">
              unexamined {claim.unexamined}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CruxCard({ crux }) {
  return (
    <div className="animate-fade-in relative bg-crux-bg border-2 border-crux-border rounded-2xl p-6 overflow-hidden">
      {/* Subtle glow effect */}
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-crux/5 rounded-full blur-3xl" />
      <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-crux/5 rounded-full blur-3xl" />

      <div className="relative">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-crux animate-crux-pulse" />
          <span className="text-crux text-xs font-bold tracking-[0.2em] uppercase">
            The Crux
          </span>
        </div>
        <p className="text-text-primary text-lg sm:text-xl font-bold leading-snug">
          {crux.text}
        </p>
        <p className="text-text-secondary text-sm mt-3 leading-relaxed">
          {crux.why}
        </p>
      </div>
    </div>
  );
}

function QuestionBlock({ question }) {
  return (
    <div className="animate-fade-in bg-surface-raised border border-border-default rounded-2xl p-6 sm:p-8">
      <span className="text-text-muted text-xs font-bold tracking-[0.2em] uppercase block mb-4">
        Before you commit, answer this
      </span>
      <p className="text-text-primary text-xl sm:text-2xl font-semibold leading-snug">
        {question}
      </p>
    </div>
  );
}

function FollowUpInput({ value, onChange, onSubmit }) {
  return (
    <div className="animate-fade-in mt-8">
      <textarea
        id="input-followup"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Answer honestly. The more specific, the better."
        className="w-full min-h-[120px] bg-surface-raised border border-border-default rounded-2xl p-5 text-text-primary text-base leading-relaxed placeholder:text-text-muted resize-y focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
      />
      <div className="mt-4 flex justify-end">
        <button
          id="btn-update-analysis"
          onClick={onSubmit}
          disabled={!value.trim()}
          className="group px-6 py-3 bg-accent hover:bg-accent/90 disabled:bg-surface-elevated disabled:text-text-muted text-white font-semibold rounded-xl transition-all shadow-lg shadow-accent-glow disabled:shadow-none cursor-pointer disabled:cursor-not-allowed"
        >
          <span className="flex items-center gap-2">
            Update analysis
            <svg
              className="w-4 h-4 transition-transform group-hover:translate-x-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
          </span>
        </button>
      </div>
    </div>
  );
}

function MapView({ analysis, followUpInput, onFollowUpChange, onFollowUpSubmit }) {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 mt-4 pb-20">
      {/* Section 1: Belief Map */}
      <div className="mb-10">
        <span className="text-text-muted text-xs font-bold tracking-[0.2em] uppercase block mb-4">
          Your reasoning, dissected
        </span>
        <div className="space-y-3 stagger-children">
          {analysis.claims.map((claim, i) => (
            <ClaimCard key={i} claim={claim} index={i} />
          ))}
        </div>
      </div>

      {/* Section 2: The Crux */}
      <div className="mb-8">
        <CruxCard crux={analysis.crux} />
      </div>

      {/* Section 3: The Question */}
      <div className="mb-2">
        <QuestionBlock question={analysis.question} />
      </div>

      {/* Section 4: Follow-up */}
      <FollowUpInput
        value={followUpInput}
        onChange={onFollowUpChange}
        onSubmit={onFollowUpSubmit}
      />
    </div>
  );
}

function ErrorView({ message, onRetry }) {
  return (
    <div className="animate-fade-in w-full max-w-2xl mx-auto px-4 mt-4">
      <div className="bg-crux-bg border border-crux-border rounded-2xl p-6 text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-crux/20 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-crux"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        </div>
        <p className="text-crux font-semibold text-base mb-2">
          Something went wrong
        </p>
        <p className="text-text-secondary text-sm mb-6">{message}</p>
        <button
          id="btn-retry"
          onClick={onRetry}
          className="px-5 py-2.5 bg-surface-elevated hover:bg-surface-raised text-text-primary font-medium rounded-xl border border-border-default transition-colors cursor-pointer"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [validationError, setValidationError] = useState("");

  const handleSubmit = useCallback(async () => {
    if (!state.input.trim()) {
      setValidationError("Write something first — even a rough draft works.");
      return;
    }
    setValidationError("");

    const messages = [{ role: "user", content: state.input.trim() }];
    dispatch({ type: "START_ANALYZING" });

    try {
      const rawXml = await callLLM(messages, state.apiKey, state.groqApiKey, state.groqModel);
      console.log("RAW MODEL OUTPUT:", rawXml);
      const analysis = parseAnalysis(rawXml);

      dispatch({
        type: "ANALYSIS_SUCCESS",
        payload: {
          analysis,
          rawXml,
          conversationHistory: [
            ...messages,
            { role: "assistant", content: rawXml },
          ],
        },
      });
    } catch (err) {
      console.error("Analysis failed:", err);
      dispatch({
        type: "ANALYSIS_ERROR",
        payload:
          err.message?.startsWith("Incomplete parse")
            ? "Couldn't parse the analysis — try rephrasing your input."
            : err.message || "API call failed. Please try again.",
      });
    }
  }, [state.input, state.apiKey, state.groqApiKey, state.groqModel]);

  const handleFollowUpSubmit = useCallback(async () => {
    if (!state.followUpInput.trim()) return;

    const userAnswer = state.followUpInput.trim();
    const currentQuestion = state.analysis?.question || "";

    const buildFollowUpMessage = (answer) =>
      `Here is my response to your question: "${answer}". Re-analyze my reasoning in light of this and update the belief map. Return ONLY raw XML in the same <analysis> format. No markdown, no code fences.`;

    dispatch({ type: "START_ANALYZING", payload: { isFollowUp: true } });

    try {
      // ── Attempt 1: use the raw answer ──
      const messages1 = [
        ...state.conversationHistory,
        { role: "user", content: buildFollowUpMessage(userAnswer) },
      ];

      const rawXml1 = await callLLM(messages1, state.apiKey, state.groqApiKey, state.groqModel);
      console.log("RAW MODEL OUTPUT (follow-up attempt 1):", rawXml1);

      try {
        const analysis1 = parseAnalysis(rawXml1);
        dispatch({
          type: "ANALYSIS_SUCCESS",
          payload: {
            analysis: analysis1,
            rawXml: rawXml1,
            conversationHistory: [
              ...messages1,
              { role: "assistant", content: rawXml1 },
            ],
          },
        });
        return;
      } catch (parseErr1) {
        console.warn("Follow-up attempt 1 parse failed, rephrasing:", parseErr1.message);
      }

      // ── Attempt 2: silently rephrase, then retry ──
      const rephrased = await rephraseUserAnswer(
        userAnswer,
        currentQuestion,
        state.apiKey,
        state.groqApiKey
      );
      console.log("Rephrased answer:", rephrased);

      const messages2 = [
        ...state.conversationHistory,
        { role: "user", content: buildFollowUpMessage(rephrased) },
      ];

      const rawXml2 = await callLLM(messages2, state.apiKey, state.groqApiKey, state.groqModel);
      console.log("RAW MODEL OUTPUT (follow-up attempt 2):", rawXml2);

      try {
        const analysis2 = parseAnalysis(rawXml2);
        dispatch({
          type: "ANALYSIS_SUCCESS",
          payload: {
            analysis: analysis2,
            rawXml: rawXml2,
            conversationHistory: [
              ...messages2,
              { role: "assistant", content: rawXml2 },
            ],
          },
        });
        return;
      } catch (parseErr2) {
        console.error("Follow-up attempt 2 also failed:", parseErr2.message);
      }

      // Both attempts failed
      dispatch({
        type: "ANALYSIS_ERROR",
        payload: "Couldn't parse the updated analysis after retrying. Try rephrasing your response.",
      });
    } catch (err) {
      console.error("Follow-up API error:", err);
      dispatch({
        type: "ANALYSIS_ERROR",
        payload: err.message || "API call failed. Please try again.",
      });
    }
  }, [state.followUpInput, state.conversationHistory, state.apiKey, state.groqApiKey, state.groqModel, state.analysis]);

  const handleReset = useCallback(() => {
    dispatch({ type: "RESET" });
    setValidationError("");
  }, []);

  return (
    <div className="min-h-screen bg-surface font-sans flex flex-col items-center">
      <Header mode={state.mode} onReset={handleReset} />

      <main className="w-full flex-1 flex flex-col items-center">
        {state.mode === "idle" && (
          <IdleView
            input={state.input}
            onInputChange={(v) => {
              dispatch({ type: "SET_INPUT", payload: v });
              if (v.trim()) setValidationError("");
            }}
            onSubmit={handleSubmit}
            validationError={validationError}
            apiKey={state.apiKey}
            onApiKeyChange={(v) => dispatch({ type: "SET_API_KEY", payload: v })}
            groqApiKey={state.groqApiKey}
            onGroqApiKeyChange={(v) => dispatch({ type: "SET_GROQ_API_KEY", payload: v })}
            groqModel={state.groqModel}
            onGroqModelChange={(v) => dispatch({ type: "SET_GROQ_MODEL", payload: v })}
          />
        )}

        {state.mode === "analyzing" && (
          <AnalyzingView input={state.input} isFollowUp={state.isFollowUp} />
        )}

        {state.mode === "map" && (
          <MapView
            analysis={state.analysis}
            followUpInput={state.followUpInput}
            onFollowUpChange={(v) =>
              dispatch({ type: "SET_FOLLOWUP_INPUT", payload: v })
            }
            onFollowUpSubmit={handleFollowUpSubmit}
          />
        )}

        {state.mode === "error" && (
          <ErrorView
            message={state.errorMessage}
            onRetry={handleReset}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="w-full py-6 text-center">
        <p className="text-text-muted text-xs">
          Powered by epistemic decomposition · No data stored
        </p>
        {import.meta.env.DEV && (
          <button
            id="btn-run-tests"
            onClick={() => runAllTests(state.apiKey, state.groqApiKey, state.groqModel)}
            className="mt-3 px-4 py-1.5 text-[11px] font-mono text-text-muted border border-border-subtle rounded-lg hover:border-accent/40 hover:text-accent transition-colors cursor-pointer"
          >
            ⚡ Run test suite
          </button>
        )}
      </footer>
    </div>
  );
}
