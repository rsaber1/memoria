import { useState, useEffect, useRef, useCallback } from "react";

const API_KEY_STORAGE  = "memoria_openai_key";
const MAX_MEMORY_CHARS = 12000;

// ── Supabase config ───────────────────────────────────────────────
const SB_URL = "https://zoocwqidfvwpggclpgzd.supabase.co";
const SB_KEY = "sb_publishable_3Yq03jOKB4PyLbNxwVgfEQ_OPt9rkGO";
const USER_ID = "default_user"; // single-user app

function sbHeaders() {
  return {
    "Content-Type": "application/json",
    "apikey": SB_KEY,
    "Authorization": `Bearer ${SB_KEY}`,
    "Prefer": "return=representation",
  };
}

async function loadSessions() {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/sessions?user_id=eq.${USER_ID}&order=created_at.asc&limit=500`,
      { headers: sbHeaders() }
    );
    if (!res.ok) throw new Error("Supabase fetch failed");
    const rows = await res.json();
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      messages: r.messages || [],
      imported: r.imported || false,
    }));
  } catch (e) {
    console.error("loadSessions:", e);
    return [];
  }
}

async function upsertSession(session) {
  try {
    await fetch(`${SB_URL}/rest/v1/sessions`, {
      method: "POST",
      headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: session.id,
        user_id: USER_ID,
        title: session.title,
        created_at: session.createdAt,
        messages: session.messages,
        imported: session.imported || false,
      }),
    });
  } catch (e) { console.error("upsertSession:", e); }
}

async function deleteSessionDb(id) {
  try {
    await fetch(`${SB_URL}/rest/v1/sessions?id=eq.${id}`, {
      method: "DELETE",
      headers: sbHeaders(),
    });
  } catch (e) { console.error("deleteSessionDb:", e); }
}

async function loadApiKey() {
  try { const r = await window.storage.get(API_KEY_STORAGE); return r ? r.value : ""; } catch { return ""; }
}
async function saveApiKey(k) {
  try { await window.storage.set(API_KEY_STORAGE, k); } catch {}
}

// ── ChatGPT export parser ────────────────────────────────────────
function parseChatGPTExport(raw) {
  // conversations.json is an array of conversation objects
  const convos = Array.isArray(raw) ? raw : [];
  const sessions = [];

  for (const convo of convos) {
    try {
      const messages = [];
      // mapping is a dict of node_id -> node
      const mapping = convo.mapping || {};
      // Walk nodes in order
      const nodes = Object.values(mapping);

      // Build ordered list by following parent links
      const roots = nodes.filter(n => !n.parent || !mapping[n.parent]);
      const visited = new Set();

      function walk(nodeId) {
        if (!nodeId || visited.has(nodeId)) return;
        visited.add(nodeId);
        const node = mapping[nodeId];
        if (!node) return;
        const msg = node.message;
        if (msg && msg.content) {
          const role = msg.author?.role;
          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (msg.content.parts) {
            text = msg.content.parts.filter(p => typeof p === "string").join(" ");
          }
          text = text.trim();
          if (text && (role === "user" || role === "assistant")) {
            messages.push({ role, content: text, id: crypto.randomUUID() });
          }
        }
        (node.children || []).forEach(walk);
      }

      // Start from nodes with no parent
      for (const node of nodes) {
        if (!node.parent) walk(node.id);
      }

      // Fallback: if walk produced nothing, try linear order
      if (messages.length === 0) {
        for (const node of nodes) {
          const msg = node.message;
          if (!msg || !msg.content) continue;
          const role = msg.author?.role;
          let text = "";
          if (typeof msg.content === "string") text = msg.content;
          else if (msg.content.parts) text = msg.content.parts.filter(p => typeof p === "string").join(" ");
          text = text.trim();
          if (text && (role === "user" || role === "assistant")) {
            messages.push({ role, content: text, id: crypto.randomUUID() });
          }
        }
      }

      if (messages.length < 2) continue;

      const title = convo.title || messages[0]?.content?.slice(0, 46) || "Imported chat";
      const createdAt = convo.create_time ? convo.create_time * 1000 : Date.now();

      sessions.push({
        id: crypto.randomUUID(),
        title: title.slice(0, 60),
        createdAt,
        messages,
        imported: true,
      });
    } catch { /* skip bad convos */ }
  }

  return sessions.sort((a, b) => a.createdAt - b.createdAt);
}

function buildMemoryContext(sessions, currentId) {
  const past = sessions.filter(s => s.id !== currentId && s.messages.length > 1);
  if (!past.length) return "";
  let ctx = "MEMORY OF PAST CONVERSATIONS (including imported ChatGPT history):\n", chars = 0;
  for (const s of [...past].reverse()) {
    const date = new Date(s.createdAt).toLocaleDateString("en-US", { year:"numeric", month:"short", day:"numeric" });
    const snippet = s.messages.slice(0, 20).map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 300)}`).join("\n");
    const entry = `\n[${s.imported ? "ChatGPT Import" : "Session"}: ${s.title} | ${date}]\n${snippet}\n`;
    if (chars + entry.length > MAX_MEMORY_CHARS) break;
    ctx += entry; chars += entry.length;
  }
  return ctx;
}

function newSession() {
  return { id: crypto.randomUUID(), title: "New conversation", createdAt: Date.now(), messages: [] };
}

// ── Icons ────────────────────────────────────────────────────────
const PlusIcon    = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
const SendIcon    = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
const TrashIcon   = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>;
const MenuIcon    = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>;
const StopIcon    = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>;
const KeyIcon     = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="8" cy="15" r="4"/><line x1="11" y1="12" x2="20" y2="3"/><line x1="18" y1="5" x2="21" y2="8"/></svg>;
const BrainIcon   = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>;
const MicIcon     = ({ active }) => <svg width="16" height="16" viewBox="0 0 24 24" fill={active?"currentColor":"none"} stroke="currentColor" strokeWidth="2"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>;
const VolOnIcon   = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>;
const VolOffIcon  = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>;
const UploadIcon  = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>;
const CheckIcon   = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>;

// ── API Key Modal ────────────────────────────────────────────────
function ApiKeyModal({ onSave }) {
  const [val, setVal] = useState("");
  return (
    <div style={Mo.overlay}>
      <div style={Mo.modal}>
        <div style={Mo.icon}><KeyIcon /></div>
        <div style={Mo.title}>Enter your OpenAI API Key</div>
        <div style={Mo.sub}>
          Stored locally — only sent directly to OpenAI.<br/>
          Get one at{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color:"#10a37f" }}>
            platform.openai.com/api-keys
          </a>
        </div>
        <input
          style={Mo.input}
          type="password"
          placeholder="sk-..."
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key==="Enter" && val.startsWith("sk-") && onSave(val.trim())}
          autoFocus
        />
        <button
          style={{ ...Mo.btn, opacity: val.startsWith("sk-") ? 1 : 0.4 }}
          onClick={() => val.startsWith("sk-") && onSave(val.trim())}
          disabled={!val.startsWith("sk-")}
        >
          Save & Start
        </button>
      </div>
    </div>
  );
}

// ── Import Modal ─────────────────────────────────────────────────
function ImportModal({ onImport, onClose }) {
  const [status, setStatus]   = useState("idle"); // idle | parsing | done | error
  const [count, setCount]     = useState(0);
  const [errMsg, setErrMsg]   = useState("");
  const fileRef               = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus("parsing");
    try {
      let json;
      if (file.name.endsWith(".zip")) {
        // Try to load JSZip from CDN
        if (!window.JSZip) {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
          });
        }
        const buf  = await file.arrayBuffer();
        const zip  = await window.JSZip.loadAsync(buf);
        const conv = zip.file("conversations.json");
        if (!conv) throw new Error("conversations.json not found in ZIP");
        const text = await conv.async("string");
        json = JSON.parse(text);
      } else if (file.name.endsWith(".json")) {
        const text = await file.text();
        json = JSON.parse(text);
      } else {
        throw new Error("Please upload conversations.json or the exported ZIP file.");
      }

      const imported = parseChatGPTExport(json);
      if (!imported.length) throw new Error("No valid conversations found.");
      setCount(imported.length);
      setStatus("done");
      onImport(imported);
    } catch (err) {
      setErrMsg(err.message || "Failed to parse file.");
      setStatus("error");
    }
  };

  return (
    <div style={Mo.overlay}>
      <div style={{ ...Mo.modal, maxWidth: 460 }}>
        <div style={{ ...Mo.icon, color:"#f59e0b" }}><UploadIcon /></div>
        <div style={Mo.title}>Import ChatGPT History</div>
        <div style={Mo.sub}>
          Export your data from ChatGPT: <b style={{color:"#aaa"}}>Settings → Data controls → Export data</b>.<br/>
          Upload the ZIP file or the extracted <b style={{color:"#aaa"}}>conversations.json</b>.
        </div>

        {status === "idle" && (
          <>
            <div
              style={Mo.dropZone}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { fileRef.current.files = e.dataTransfer.files; handleFile({ target: { files: [f] } }); }}}
            >
              <UploadIcon />
              <span style={{ marginLeft:8 }}>Click to browse or drag & drop</span>
              <span style={{ fontSize:11, color:"#444", marginTop:4 }}>conversations.json or exported .zip</span>
            </div>
            <input ref={fileRef} type="file" accept=".json,.zip" style={{ display:"none" }} onChange={handleFile} />
          </>
        )}

        {status === "parsing" && (
          <div style={{ display:"flex", alignItems:"center", gap:10, color:"#888", fontSize:13 }}>
            <div style={Mo.spinner} /> Parsing conversations…
          </div>
        )}

        {status === "done" && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
            <div style={{ color:"#10a37f", display:"flex", alignItems:"center", gap:8, fontSize:15, fontWeight:600 }}>
              <CheckIcon /> {count} conversations imported!
            </div>
            <div style={{ fontSize:12, color:"#555" }}>They're now part of your memory context.</div>
            <button style={{ ...Mo.btn, marginTop:4 }} onClick={onClose}>Done</button>
          </div>
        )}

        {status === "error" && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
            <div style={{ color:"#ef4444", fontSize:13 }}>⚠ {errMsg}</div>
            <button style={{ ...Mo.btn, background:"#1e1e1e", color:"#aaa" }} onClick={() => setStatus("idle")}>Try again</button>
          </div>
        )}

        {status !== "done" && (
          <button style={{ background:"none", border:"none", color:"#444", fontSize:12, cursor:"pointer", marginTop:4 }} onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────
export default function MemoryAssistant() {
  const [sessions, setSessions]         = useState([]);
  const [currentId, setCurrentId]       = useState(null);
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [sidebarOpen, setSidebarOpen]   = useState(true);
  const [initialized, setInitialized]   = useState(false);
  const [apiKey, setApiKey]             = useState(null);
  const [isListening, setIsListening]   = useState(false);
  const [isSpeaking, setIsSpeaking]     = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speakingId, setSpeakingId]     = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [showImport, setShowImport]     = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);
  const audioRef       = useRef(null);

  useEffect(() => {
    Promise.all([loadSessions(), loadApiKey()]).then(([loaded, key]) => {
      if (loaded.length > 0) {
        setSessions(loaded);
        setCurrentId(loaded[loaded.length - 1].id);
        setImportedCount(loaded.filter(s => s.imported).length);
      } else {
        const s = newSession();
        setSessions([s]);
        setCurrentId(s.id);
        upsertSession(s);
      }
      setApiKey(key);
      setInitialized(true);
    });
  }, []);

  // Sessions are saved to Supabase individually via upsertSession on change
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [sessions, currentId, loading]);

  const currentSession = sessions.find(s => s.id === currentId);

  const handleSaveKey = useCallback(async (key) => {
    await saveApiKey(key);
    setApiKey(key);
    setShowKeyModal(false);
  }, []);

  const handleImport = useCallback((imported) => {
    setSessions(prev => {
      const existing = new Set(prev.map(s => `${s.title}|${s.createdAt}`));
      const fresh = imported.filter(s => !existing.has(`${s.title}|${s.createdAt}`));
      fresh.forEach(s => upsertSession(s));
      const next = [...fresh, ...prev];
      return next;
    });
    setImportedCount(c => c + imported.length);
  }, []);

  // ── TTS ──
  const stopSpeaking = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setIsSpeaking(false); setSpeakingId(null);
  }, []);

  const speak = useCallback(async (text, msgId) => {
    if (!apiKey) return;
    stopSpeaking();
    const clean = text.replace(/[*_`#>]/g, "").replace(/\n+/g, " ").slice(0, 4000);
    setIsSpeaking(true); setSpeakingId(msgId);
    try {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
        body: JSON.stringify({ model:"tts-1", voice:"nova", input: clean, speed: 1.0 }),
      });
      if (!res.ok) throw new Error("TTS failed");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setIsSpeaking(false); setSpeakingId(null); URL.revokeObjectURL(url); };
      audio.onerror = () => { setIsSpeaking(false); setSpeakingId(null); };
      audio.play();
    } catch { setIsSpeaking(false); setSpeakingId(null); }
  }, [apiKey, stopSpeaking]);

  // ── Voice Input: Web Speech API (primary, works on mobile) ──
  const recognitionRef = useRef(null);

  const startListening = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Voice input isn't supported in this browser. Please use Chrome or Safari.");
      return;
    }
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalTranscript = "";

    rec.onstart = () => setIsListening(true);

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript;
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      // Show live preview in input
      setInput(finalTranscript || interim);
    };

    rec.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      // If we got a transcript, leave it in the input ready to send
    };

    rec.onerror = (e) => {
      setIsListening(false);
      recognitionRef.current = null;
      if (e.error === "not-allowed") alert("Microphone access denied. Please allow mic access in your browser settings.");
    };

    recognitionRef.current = rec;
    try { rec.start(); } catch { setIsListening(false); }
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const createSession = useCallback(() => {
    stopSpeaking();
    const s = newSession();
    setSessions(prev => [...prev, s]);
    setCurrentId(s.id);
    upsertSession(s);
  }, [stopSpeaking]);

  const deleteSession = useCallback((id) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (!next.length) { const s = newSession(); setCurrentId(s.id); upsertSession(s); return [s]; }
      if (id === currentId) setCurrentId(next[next.length - 1].id);
      return next;
    });
    deleteSessionDb(id);
  }, [currentId]);

  const updateSession = useCallback((id, fn) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== id) return s;
      const updated = fn(s);
      upsertSession(updated);
      return updated;
    }));
  }, []);

  // ── Send ──
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || !currentSession || !apiKey) return;
    stopSpeaking();

    const userMsg  = { role:"user", content: text };
    const updated  = [...currentSession.messages, userMsg];
    const isFirst  = currentSession.messages.length === 0;

    updateSession(currentId, s => ({
      ...s, messages: updated,
      title: isFirst ? text.slice(0, 46) + (text.length>46?"…":"") : s.title,
    }));
    setInput(""); setLoading(true);

    try {
      const memory = buildMemoryContext(sessions, currentId);
      const systemPrompt = `You are a warm, helpful AI assistant with perfect memory of all past conversations with this user — including their imported ChatGPT history. You recall details naturally and without being prompted, referencing past topics, preferences, and context as if you genuinely remember them.

${memory ? memory + "\n\nDraw on this memory naturally and helpfully." : "This is your very first conversation with this user."}

Today is ${new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}.`;

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method:"POST",
        headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"gpt-4o",
          messages:[{ role:"system", content: systemPrompt }, ...updated.map(m=>({role:m.role,content:m.content}))],
          max_tokens:1000, temperature:0.7,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const reply = data.choices?.[0]?.message?.content || "Sorry, I couldn't respond.";
      const msgId = crypto.randomUUID();

      updateSession(currentId, s => ({
        ...s, messages:[...s.messages, { role:"assistant", content:reply, id:msgId }],
      }));
      if (voiceEnabled) speak(reply, msgId);
    } catch (err) {
      updateSession(currentId, s => ({
        ...s, messages:[...s.messages, { role:"assistant", content:`Error: ${err.message}`, id:crypto.randomUUID() }],
      }));
    } finally {
      setLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [input, loading, currentSession, currentId, sessions, apiKey, voiceEnabled, speak, stopSpeaking, updateSession]);

  const handleKeyDown = e => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  if (!initialized || apiKey === null) return <div style={S.loadingScreen}><div style={S.spinner}/></div>;

  const nativeCount  = sessions.filter(s => !s.imported).length;
  const chatGptCount = sessions.filter(s => s.imported).length;

  return (
    <div style={S.app}>
      {(!apiKey || showKeyModal) && <ApiKeyModal onSave={handleSaveKey}/>}
      {showImport && <ImportModal onImport={handleImport} onClose={() => setShowImport(false)}/>}

      {/* Sidebar */}
      <div style={{ ...S.sidebar, width: sidebarOpen ? "268px" : "0" }}>
        <div style={S.sidebarInner}>
          <div style={S.sidebarTop}>
            <div style={S.brand}><BrainIcon /><span style={S.brandName}>Memoria</span></div>
            <button style={S.iconBtn} onClick={createSession} title="New chat"><PlusIcon /></button>
          </div>

          <div style={S.label}>CONVERSATIONS</div>
          <div style={S.sessionList}>
            {[...sessions].reverse().map(s => (
              <div key={s.id}
                style={{ ...S.sessionItem, ...(s.id===currentId ? S.sessionActive : {}) }}
                onClick={() => { stopSpeaking(); setCurrentId(s.id); }}>
                {s.imported && <div style={S.importedTag}>GPT</div>}
                <div style={{ ...S.sessionTitle, paddingRight: s.imported ? 42 : 18 }}>{s.title}</div>
                <div style={S.sessionDate}>{new Date(s.createdAt).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</div>
                <button style={S.delBtn} onClick={e => { e.stopPropagation(); deleteSession(s.id); }}><TrashIcon /></button>
              </div>
            ))}
          </div>

          <div style={S.footer}>
            <div style={S.memStats}>
              <div style={S.memDot}/>
              <span>{nativeCount} session{nativeCount!==1?"s":""}</span>
              {chatGptCount > 0 && <span style={{ color:"#f59e0b", marginLeft:6 }}>· {chatGptCount} ChatGPT</span>}
              <span style={{ color:"#333", marginLeft:4 }}>in memory</span>
            </div>
            <div style={S.syncBadge}>
              <div style={S.syncDot}/>
              <span>Synced across devices</span>
            </div>
            <button style={S.footBtn} onClick={() => setShowImport(true)}>
              <UploadIcon /><span>Import ChatGPT history</span>
            </button>
            <button style={S.footBtn} onClick={() => setShowKeyModal(true)}>
              <KeyIcon /><span>Change API key</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={S.main}>
        <div style={S.topbar}>
          <button style={S.dimBtn} onClick={() => setSidebarOpen(v=>!v)}><MenuIcon /></button>
          <span style={S.topTitle}>{currentSession?.title || "New conversation"}</span>
          {currentSession?.imported && <span style={S.gptTag}>ChatGPT import</span>}
          <div style={S.topRight}>
            {isSpeaking && <button style={{ ...S.topBtn, color:"#ef4444" }} onClick={stopSpeaking} title="Stop"><StopIcon /></button>}
            <button
              style={{ ...S.topBtn, color: voiceEnabled ? "#10a37f" : "#333" }}
              onClick={() => { setVoiceEnabled(v=>!v); stopSpeaking(); }}
              title={voiceEnabled?"Mute voice":"Enable voice"}
            >
              {voiceEnabled ? <VolOnIcon /> : <VolOffIcon />}
            </button>
          </div>
        </div>

        <div style={S.messages}>
          {currentSession?.messages.length === 0 && (
            <div style={S.empty}>
              <div style={S.emptyIcon}><BrainIcon /></div>
              <div style={S.emptyTitle}>What's on your mind?</div>
              <div style={S.emptySub}>
                GPT-4o · Nova voice · Unlimited memory
                {chatGptCount > 0 && <><br/><span style={{ color:"#f59e0b" }}>✓ {chatGptCount} ChatGPT conversations loaded</span></>}
                <br/>Type or tap the mic — I remember everything.
              </div>
            </div>
          )}

          {currentSession?.messages.map((msg, i) => (
            <div key={i} style={{ ...S.row, justifyContent: msg.role==="user" ? "flex-end" : "flex-start" }}>
              {msg.role==="assistant" && <div style={S.avatar}><BrainIcon /></div>}
              <div style={msg.role==="user" ? S.userBubble : S.aiBubble}>
                {msg.content.split("\n").map((line,j,arr)=>(
                  <span key={j}>{line}{j<arr.length-1&&<br/>}</span>
                ))}
                {msg.role==="assistant" && (
                  <button
                    style={{ ...S.readBtn, color: speakingId===msg.id?"#10a37f":"#2e2e2e" }}
                    onClick={() => speakingId===msg.id ? stopSpeaking() : speak(msg.content,msg.id)}
                    title={speakingId===msg.id?"Stop":"Read aloud"}
                  >
                    {speakingId===msg.id ? <StopIcon/> : <VolOnIcon/>}
                  </button>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div style={{ ...S.row, justifyContent:"flex-start" }}>
              <div style={S.avatar}><BrainIcon /></div>
              <div style={S.aiBubble}>
                <div style={S.dotRow}>
                  <span style={{ ...S.dot, animationDelay:"0ms" }}/>
                  <span style={{ ...S.dot, animationDelay:"160ms" }}/>
                  <span style={{ ...S.dot, animationDelay:"320ms" }}/>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef}/>
        </div>

        <div style={S.inputArea}>
          {isListening && (
            <div style={S.listenBar}><div style={S.listenDot}/><span>Listening… speak now, tap mic to stop</span></div>
          )}
          <div style={S.inputRow}>
            <button
              style={{ ...S.micBtn, color:isListening?"#ef4444":"#484848", background:isListening?"rgba(239,68,68,0.1)":"transparent" }}
              onClick={() => isListening ? stopListening() : startListening()}
              title={isListening?"Stop listening":"Voice input"}
            >
              <MicIcon active={isListening}/>
            </button>
            <textarea
              ref={textareaRef}
              style={S.textarea}
              value={input}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isListening?"Listening… speak now":"Message Memoria…"}
              rows={1}
            />
            <button
              style={{ ...S.sendBtn, opacity: input.trim()&&!loading?1:0.3 }}
              onClick={sendMessage}
              disabled={!input.trim()||loading}
            >
              <SendIcon/>
            </button>
          </div>
          <div style={S.hint}>GPT-4o · Nova voice · Enter to send</div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-thumb { background:#1e1e1e; border-radius:4px; }
        textarea { resize:none; font-family:'DM Sans',sans-serif; }
        button { transition:opacity 0.15s,filter 0.15s; }
        button:hover { filter:brightness(1.25); }
        button:active { opacity:0.7; }
        @keyframes pulse  { 0%,100%{opacity:.25;transform:scale(.75)} 50%{opacity:1;transform:scale(1)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin   { to{transform:rotate(360deg)} }
        @keyframes ripple { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(2);opacity:.2} }
      `}</style>
    </div>
  );
}

// ── App Styles ───────────────────────────────────────────────────
const S = {
  app:          { display:"flex", height:"100vh", background:"#0a0a0a", fontFamily:"'DM Sans',sans-serif", color:"#e0e0e0", overflow:"hidden" },
  loadingScreen:{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", background:"#0a0a0a" },
  spinner:      { width:30, height:30, borderRadius:"50%", border:"2px solid #1e1e1e", borderTop:"2px solid #10a37f", animation:"spin 0.8s linear infinite" },
  sidebar:      { background:"#0d0d0d", borderRight:"1px solid #181818", transition:"width 0.25s ease", flexShrink:0, overflow:"hidden" },
  sidebarInner: { width:268, height:"100%", display:"flex", flexDirection:"column", padding:"16px 0" },
  sidebarTop:   { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 14px 16px" },
  brand:        { display:"flex", alignItems:"center", gap:8, color:"#10a37f" },
  brandName:    { fontFamily:"'Syne',sans-serif", fontWeight:700, fontSize:17, color:"#e8e8e8" },
  iconBtn:      { background:"#1a1a1a", border:"1px solid #252525", color:"#777", width:28, height:28, borderRadius:6, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" },
  label:        { fontSize:10, fontWeight:600, letterSpacing:"0.1em", color:"#2a2a2a", padding:"0 14px 8px" },
  sessionList:  { flex:1, overflowY:"auto", padding:"0 6px" },
  sessionItem:  { padding:"9px 10px", borderRadius:7, cursor:"pointer", marginBottom:2, position:"relative" },
  sessionActive:{ background:"#0d1f1a", borderLeft:"2px solid #10a37f" },
  importedTag:  { position:"absolute", right:24, top:10, background:"#2a1f00", color:"#f59e0b", fontSize:9, fontWeight:700, padding:"1px 5px", borderRadius:4, letterSpacing:"0.05em" },
  sessionTitle: { fontSize:13, color:"#aaa", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  sessionDate:  { fontSize:11, color:"#2e2e2e", marginTop:2 },
  delBtn:       { position:"absolute", right:4, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"#2e2e2e", cursor:"pointer", padding:4, borderRadius:4, display:"flex", alignItems:"center" },
  footer:       { padding:"10px 12px 0", borderTop:"1px solid #181818", marginTop:6, display:"flex", flexDirection:"column", gap:6 },
  memStats:     { display:"flex", alignItems:"center", gap:4, fontSize:11, color:"#333", paddingBottom:2 },
  memDot:       { width:6, height:6, borderRadius:"50%", background:"#10a37f", boxShadow:"0 0 8px rgba(16,163,127,0.5)", marginRight:2 },
  syncBadge:    { display:"flex", alignItems:"center", gap:6, fontSize:10, color:"#2a2a2a", paddingBottom:2 },
  syncDot:      { width:5, height:5, borderRadius:"50%", background:"#10a37f", opacity:0.5 },
  footBtn:      { display:"flex", alignItems:"center", gap:7, background:"none", border:"1px solid #1e1e1e", color:"#444", fontSize:11, padding:"6px 10px", borderRadius:6, cursor:"pointer", width:"100%" },
  main:         { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  topbar:       { display:"flex", alignItems:"center", gap:10, padding:"11px 18px", borderBottom:"1px solid #161616", background:"#0b0b0b" },
  dimBtn:       { background:"none", border:"none", color:"#404040", cursor:"pointer", padding:4, display:"flex", alignItems:"center" },
  topTitle:     { fontSize:13, color:"#484848", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:300 },
  gptTag:       { background:"#2a1f00", color:"#f59e0b", fontSize:10, fontWeight:600, padding:"2px 7px", borderRadius:4 },
  topRight:     { marginLeft:"auto", display:"flex", gap:4 },
  topBtn:       { background:"none", border:"none", cursor:"pointer", padding:6, display:"flex", alignItems:"center", borderRadius:6 },
  messages:     { flex:1, overflowY:"auto", padding:"28px 18px", display:"flex", flexDirection:"column", gap:14 },
  empty:        { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", padding:"60px 20px", animation:"fadeIn 0.5s ease" },
  emptyIcon:    { color:"#10a37f", filter:"drop-shadow(0 0 16px rgba(16,163,127,0.4))", transform:"scale(2.2)", marginBottom:8 },
  emptyTitle:   { fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, color:"#e0e0e0", marginTop:26, marginBottom:10 },
  emptySub:     { fontSize:13, color:"#383838", lineHeight:1.9 },
  row:          { display:"flex", alignItems:"flex-end", gap:10, animation:"fadeIn 0.25s ease" },
  avatar:       { width:32, height:32, borderRadius:8, background:"#101a17", border:"1px solid #1a2e28", display:"flex", alignItems:"center", justifyContent:"center", color:"#10a37f", flexShrink:0 },
  userBubble:   { maxWidth:"70%", background:"#10a37f", color:"#fff", borderRadius:"16px 16px 4px 16px", padding:"10px 14px", fontSize:14, lineHeight:1.6 },
  aiBubble:     { maxWidth:"75%", background:"#111", border:"1px solid #1c1c1c", color:"#d0d0d0", borderRadius:"16px 16px 16px 4px", padding:"10px 14px 8px", fontSize:14, lineHeight:1.6 },
  readBtn:      { background:"none", border:"none", cursor:"pointer", padding:"4px 0 0", display:"flex", alignItems:"center", marginTop:4 },
  dotRow:       { display:"flex", gap:4, alignItems:"center", height:18 },
  dot:          { display:"inline-block", width:6, height:6, borderRadius:"50%", background:"#10a37f", animation:"pulse 1s ease-in-out infinite" },
  inputArea:    { padding:"10px 18px 13px", borderTop:"1px solid #161616", background:"#0b0b0b" },
  listenBar:    { display:"flex", alignItems:"center", gap:8, padding:"4px 4px 8px", fontSize:12, color:"#ef4444" },
  listenDot:    { width:7, height:7, borderRadius:"50%", background:"#ef4444", animation:"ripple 1s ease-in-out infinite" },
  inputRow:     { display:"flex", alignItems:"flex-end", gap:6, background:"#111", border:"1px solid #1e1e1e", borderRadius:12, padding:"6px 8px 6px 6px" },
  micBtn:       { width:34, height:34, borderRadius:8, border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  textarea:     { flex:1, background:"none", border:"none", outline:"none", color:"#ddd", fontSize:14, lineHeight:1.5, minHeight:22, maxHeight:120, overflowY:"auto", padding:"4px 0" },
  sendBtn:      { background:"#10a37f", border:"none", color:"#fff", width:32, height:32, borderRadius:8, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  hint:         { fontSize:11, color:"#202020", textAlign:"center", marginTop:7 },
};

// ── Modal Styles ─────────────────────────────────────────────────
const Mo = {
  overlay:  { position:"fixed", inset:0, background:"rgba(0,0,0,0.88)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:999, backdropFilter:"blur(4px)" },
  modal:    { background:"#0f0f0f", border:"1px solid #222", borderRadius:16, padding:"32px 28px", width:"100%", maxWidth:420, display:"flex", flexDirection:"column", alignItems:"center", gap:12 },
  icon:     { color:"#10a37f", transform:"scale(1.8)", marginBottom:8 },
  title:    { fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:700, color:"#e8e8e8" },
  sub:      { fontSize:13, color:"#555", textAlign:"center", lineHeight:1.8 },
  input:    { width:"100%", background:"#0a0a0a", border:"1px solid #2a2a2a", borderRadius:8, padding:"10px 14px", color:"#e0e0e0", fontSize:14, outline:"none", fontFamily:"monospace", marginTop:4 },
  btn:      { background:"#10a37f", border:"none", color:"#fff", padding:"11px 28px", borderRadius:8, fontSize:14, fontWeight:600, cursor:"pointer", marginTop:4, width:"100%" },
  dropZone: { width:"100%", border:"1px dashed #2a2a2a", borderRadius:10, padding:"24px 16px", display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:"pointer", color:"#555", fontSize:13, marginTop:4 },
  spinner:  { width:18, height:18, borderRadius:"50%", border:"2px solid #222", borderTop:"2px solid #10a37f", animation:"spin 0.8s linear infinite" },
};
