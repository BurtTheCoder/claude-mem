#!/usr/bin/env node
import I from"path";import{stdin as _}from"process";import N from"better-sqlite3";import*as T from"sqlite-vec";import*as g from"sqlite-lembed";import{homedir as f}from"os";import{join as p}from"path";import{mkdirSync as v,existsSync as h}from"fs";import{createHash as O}from"crypto";var R=384,l="all-MiniLM-L6-v2",L=p(f(),".claude-mem","models","all-MiniLM-L6-v2.gguf"),u=class{db;dataDir;modelPath;lembedAvailable=!1;constructor(e={}){let s=typeof e=="string"?{dataDir:e}:e;this.dataDir=s.dataDir||p(f(),".claude-mem"),this.modelPath=s.modelPath||L,h(this.dataDir)||v(this.dataDir,{recursive:!0});let n=p(this.dataDir,"simple-memory.db");this.db=new N(n),T.load(this.db);try{g.load(this.db),this.initLembed()}catch(t){console.warn("[SimpleMemory] sqlite-lembed not available, semantic search disabled:",t.message)}this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("cache_size = 10000"),this.initSchema()}initLembed(){if(!h(this.modelPath)){console.warn(`[SimpleMemory] Model not found at ${this.modelPath}`),console.warn("[SimpleMemory] Download with: curl -L -o ~/.claude-mem/models/all-MiniLM-L6-v2.gguf https://huggingface.co/asg017/sqlite-lembed-model-examples/resolve/main/all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf");return}try{this.db.exec(`
        INSERT INTO temp.lembed_models(name, model)
        SELECT '${l}', lembed_model_from_file('${this.modelPath}')
        WHERE NOT EXISTS (SELECT 1 FROM temp.lembed_models WHERE name = '${l}')
      `),this.lembedAvailable=!0,console.log("[SimpleMemory] sqlite-lembed initialized with",l)}catch(e){console.warn("[SimpleMemory] Failed to register embedding model:",e.message)}}isSemanticSearchAvailable(){return this.lembedAvailable}initSchema(){this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
    `),this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_output TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        files_touched TEXT,
        event_type TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON tool_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_project ON tool_events(project);
      CREATE INDEX IF NOT EXISTS idx_events_created ON tool_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_tool ON tool_events(tool_name);
    `);try{this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS event_embeddings USING vec0(
          event_id INTEGER PRIMARY KEY,
          embedding float[${R}]
        );
      `)}catch(e){if(!e.message.includes("already exists"))throw e}this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        event_id INTEGER PRIMARY KEY,
        text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(event_id) REFERENCES tool_events(id) ON DELETE CASCADE
      );
    `)}startSession(e,s,n){this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project, user_prompt, started_at)
      VALUES (?, ?, ?, ?)
    `).run(e,s,n,Date.now())}endSession(e){this.db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ?
    `).run(Date.now(),e)}recordEvent(e){let s=this.extractMetadata(e);return this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.session_id,e.project,e.tool_name,e.tool_input,e.tool_output,e.cwd,e.created_at||Date.now(),s.files_touched?JSON.stringify(s.files_touched):null,s.event_type).lastInsertRowid}extractMetadata(e){let s=[],n="other";switch(e.tool_name){case"Read":n="read";try{let t=JSON.parse(e.tool_input);t.file_path&&s.push(t.file_path)}catch{}break;case"Write":case"Edit":case"MultiEdit":n="write";try{let t=JSON.parse(e.tool_input);t.file_path&&s.push(t.file_path)}catch{}break;case"Bash":n="exec";break;case"Glob":case"Grep":n="search";try{let t=JSON.parse(e.tool_input);t.path&&s.push(t.path)}catch{}break;default:n="other"}return{files_touched:s,event_type:n}}getRecentEvents(e,s=50){return this.db.prepare(`
      SELECT * FROM tool_events
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(e,s).map(i=>({id:i.id,session_id:i.session_id,project:i.project,tool_name:i.tool_name,tool_input:i.tool_input,tool_output:i.tool_output,cwd:i.cwd,created_at:i.created_at,files_touched:i.files_touched?JSON.parse(i.files_touched):void 0,event_type:i.event_type}))}getEmbeddableText(e){let s=[];s.push(`[${e.tool_name}]`);try{let t=JSON.parse(e.tool_input);t.file_path&&s.push(t.file_path),t.pattern&&s.push(t.pattern),t.query&&s.push(t.query),t.command&&s.push(t.command)}catch{let t=e.tool_input.slice(0,500);s.push(t)}let n=e.tool_output.slice(0,1e3);return s.push(n),s.join(" ")}generateEmbedding(e){if(!this.lembedAvailable)return null;try{return this.db.prepare(`SELECT lembed('${l}', ?) as embedding`).get(e)?.embedding||null}catch(s){return console.warn("[SimpleMemory] Embedding generation failed:",s.message),null}}searchEvents(e,s={}){let{project:n,limit:t=20,semantic:i=!0}=s;return i&&this.lembedAvailable?this.semanticSearch(e,{project:n,limit:t}):this.textSearch(e,{project:n,limit:t})}semanticSearch(e,s){let{project:n,limit:t=20}=s;this.ensureEmbeddings(t*2);let i=this.generateEmbedding(e);if(!i)return this.textSearch(e,{project:n,limit:t});let r=this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(i,t*2);return(n?r.filter(o=>o.project===n).slice(0,t):r.slice(0,t)).map(o=>({event:{id:o.id,session_id:o.session_id,project:o.project,tool_name:o.tool_name,tool_input:o.tool_input,tool_output:o.tool_output,cwd:o.cwd,created_at:o.created_at,files_touched:o.files_touched?JSON.parse(o.files_touched):void 0,event_type:o.event_type},distance:o.distance}))}textSearch(e,s){let{project:n,limit:t=20}=s,i=`
      SELECT * FROM tool_events
      WHERE (
        tool_input LIKE ? OR
        tool_output LIKE ?
      )
    `,a=[`%${e}%`,`%${e}%`];return n&&(i+=" AND project = ?",a.push(n)),i+=" ORDER BY created_at DESC LIMIT ?",a.push(t),this.db.prepare(i).all(...a).map(o=>({event:{id:o.id,session_id:o.session_id,project:o.project,tool_name:o.tool_name,tool_input:o.tool_input,tool_output:o.tool_output,cwd:o.cwd,created_at:o.created_at,files_touched:o.files_touched?JSON.parse(o.files_touched):void 0,event_type:o.event_type},distance:0}))}ensureEmbeddings(e=100){if(!this.lembedAvailable)return;let s=this.getEventsWithoutEmbeddings(e);for(let n of s){if(!n.id)continue;let t=this.getEmbeddableText(n),i=O("md5").update(t).digest("hex"),a=this.generateEmbedding(t);if(a)try{this.db.exec(`
            INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
            VALUES (${n.id}, x'${a.toString("hex")}')
          `),this.db.prepare(`
            INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
            VALUES (?, ?, ?)
          `).run(n.id,i,Date.now())}catch(r){console.warn(`[SimpleMemory] Failed to store embedding for event ${n.id}:`,r.message)}}}searchByVector(e,s={}){let{limit:n=20}=s,t=Buffer.from(new Float32Array(e).buffer);return this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(t,n).map(r=>({event:{id:r.id,session_id:r.session_id,project:r.project,tool_name:r.tool_name,tool_input:r.tool_input,tool_output:r.tool_output,cwd:r.cwd,created_at:r.created_at,files_touched:r.files_touched?JSON.parse(r.files_touched):void 0,event_type:r.event_type},distance:r.distance}))}storeEmbedding(e,s,n){let t=JSON.stringify(s);this.db.exec(`
      INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
      VALUES (${e}, '${t}')
    `),this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
      VALUES (?, ?, ?)
    `).run(e,n,Date.now())}hasEmbedding(e){return this.db.prepare("SELECT 1 FROM embedding_cache WHERE event_id = ?").get(e)!==void 0}getEventsWithoutEmbeddings(e=100){return this.db.prepare(`
      SELECT t.* FROM tool_events t
      LEFT JOIN embedding_cache c ON c.event_id = t.id
      WHERE c.event_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(e).map(t=>({id:t.id,session_id:t.session_id,project:t.project,tool_name:t.tool_name,tool_input:t.tool_input,tool_output:t.tool_output,cwd:t.cwd,created_at:t.created_at,files_touched:t.files_touched?JSON.parse(t.files_touched):void 0,event_type:t.event_type}))}formatContext(e){if(e.length===0)return"No recent activity found for this project.";let s=[`# Recent Activity
`],n=new Map;for(let t of e){let i=new Date(t.created_at).toLocaleDateString();n.has(i)||n.set(i,[]),n.get(i).push(t)}for(let[t,i]of n){s.push(`## ${t}
`);for(let a of i){let r=new Date(a.created_at).toLocaleTimeString(),c=a.files_touched?.join(", ")||"",o=c?` (${c})`:"";s.push(`- **${r}** [${a.tool_name}]${o}`);let E=a.tool_output.length>200?a.tool_output.slice(0,200)+"...":a.tool_output;E&&a.tool_name!=="Read"&&s.push(`  ${E.replace(/\n/g,`
  `)}`)}s.push("")}return s.join(`
`)}close(){this.db.close()}},m=null;function b(){return m||(m=new u),m}function S(d){let e=d?.cwd??process.cwd(),s=e?I.basename(e):"unknown-project";try{let n=b();d?.session_id&&n.startSession(d.session_id,s,"");let t=n.getRecentEvents(s,50);return t.length===0?"":`<claude-mem-context>
${n.formatContext(t)}
</claude-mem-context>`}catch(n){return console.error("[context-hook] Error:",n.message),""}}var y=process.argv.includes("--colors");if(_.isTTY||y){let d=S(void 0);console.log(d),process.exit(0)}else{let d="";_.on("data",e=>d+=e),_.on("end",()=>{let e=d.trim()?JSON.parse(d):void 0,s=S(e);console.log(JSON.stringify(s?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s}}:{continue:!0,suppressOutput:!0})),process.exit(0)})}
