#!/usr/bin/env node
import A from"path";import{stdin as v}from"process";import N from"better-sqlite3";import*as T from"sqlite-vec";import*as f from"sqlite-lembed";import{homedir as b}from"os";import{join as u}from"path";import{mkdirSync as O,existsSync as g}from"fs";import{createHash as R}from"crypto";var y=384,m="all-MiniLM-L6-v2",L=u(b(),".claude-mem","models","all-MiniLM-L6-v2.gguf"),_=class{db;dataDir;modelPath;lembedAvailable=!1;constructor(t={}){let s=typeof t=="string"?{dataDir:t}:t;this.dataDir=s.dataDir||u(b(),".claude-mem"),this.modelPath=s.modelPath||L,g(this.dataDir)||O(this.dataDir,{recursive:!0});let i=u(this.dataDir,"simple-memory.db");this.db=new N(i),T.load(this.db);try{f.load(this.db),this.initLembed()}catch(e){console.warn("[SimpleMemory] sqlite-lembed not available, semantic search disabled:",e.message)}this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("cache_size = 10000"),this.initSchema()}initLembed(){if(!g(this.modelPath)){console.warn(`[SimpleMemory] Model not found at ${this.modelPath}`),console.warn("[SimpleMemory] Download with: curl -L -o ~/.claude-mem/models/all-MiniLM-L6-v2.gguf https://huggingface.co/asg017/sqlite-lembed-model-examples/resolve/main/all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf");return}try{this.db.exec(`
        INSERT INTO temp.lembed_models(name, model)
        SELECT '${m}', lembed_model_from_file('${this.modelPath}')
        WHERE NOT EXISTS (SELECT 1 FROM temp.lembed_models WHERE name = '${m}')
      `),this.lembedAvailable=!0,console.log("[SimpleMemory] sqlite-lembed initialized with",m)}catch(t){console.warn("[SimpleMemory] Failed to register embedding model:",t.message)}}isSemanticSearchAvailable(){return this.lembedAvailable}initSchema(){this.db.exec(`
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
          embedding float[${y}]
        );
      `)}catch(t){if(!t.message.includes("already exists"))throw t}this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        event_id INTEGER PRIMARY KEY,
        text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(event_id) REFERENCES tool_events(id) ON DELETE CASCADE
      );
    `)}startSession(t,s,i){this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project, user_prompt, started_at)
      VALUES (?, ?, ?, ?)
    `).run(t,s,i,Date.now())}endSession(t){this.db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ?
    `).run(Date.now(),t)}recordEvent(t){let s=this.extractMetadata(t);return this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t.session_id,t.project,t.tool_name,t.tool_input,t.tool_output,t.cwd,t.created_at||Date.now(),s.files_touched?JSON.stringify(s.files_touched):null,s.event_type).lastInsertRowid}extractMetadata(t){let s=[],i="other";switch(t.tool_name){case"Read":i="read";try{let e=JSON.parse(t.tool_input);e.file_path&&s.push(e.file_path)}catch{}break;case"Write":case"Edit":case"MultiEdit":i="write";try{let e=JSON.parse(t.tool_input);e.file_path&&s.push(e.file_path)}catch{}break;case"Bash":i="exec";break;case"Glob":case"Grep":i="search";try{let e=JSON.parse(t.tool_input);e.path&&s.push(e.path)}catch{}break;default:i="other"}return{files_touched:s,event_type:i}}getRecentEvents(t,s=50){return this.db.prepare(`
      SELECT * FROM tool_events
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(t,s).map(n=>({id:n.id,session_id:n.session_id,project:n.project,tool_name:n.tool_name,tool_input:n.tool_input,tool_output:n.tool_output,cwd:n.cwd,created_at:n.created_at,files_touched:n.files_touched?JSON.parse(n.files_touched):void 0,event_type:n.event_type}))}getEmbeddableText(t){let s=[];s.push(`[${t.tool_name}]`);try{let e=JSON.parse(t.tool_input);e.file_path&&s.push(e.file_path),e.pattern&&s.push(e.pattern),e.query&&s.push(e.query),e.command&&s.push(e.command)}catch{let e=t.tool_input.slice(0,500);s.push(e)}let i=t.tool_output.slice(0,1e3);return s.push(i),s.join(" ")}generateEmbedding(t){if(!this.lembedAvailable)return null;try{return this.db.prepare(`SELECT lembed('${m}', ?) as embedding`).get(t)?.embedding||null}catch(s){return console.warn("[SimpleMemory] Embedding generation failed:",s.message),null}}searchEvents(t,s={}){let{project:i,limit:e=20,semantic:n=!0}=s;return n&&this.lembedAvailable?this.semanticSearch(t,{project:i,limit:e}):this.textSearch(t,{project:i,limit:e})}semanticSearch(t,s){let{project:i,limit:e=20}=s;this.ensureEmbeddings(e*2);let n=this.generateEmbedding(t);if(!n)return this.textSearch(t,{project:i,limit:e});let r=this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(n,e*2);return(i?r.filter(o=>o.project===i).slice(0,e):r.slice(0,e)).map(o=>({event:{id:o.id,session_id:o.session_id,project:o.project,tool_name:o.tool_name,tool_input:o.tool_input,tool_output:o.tool_output,cwd:o.cwd,created_at:o.created_at,files_touched:o.files_touched?JSON.parse(o.files_touched):void 0,event_type:o.event_type},distance:o.distance}))}textSearch(t,s){let{project:i,limit:e=20}=s,n=`
      SELECT * FROM tool_events
      WHERE (
        tool_input LIKE ? OR
        tool_output LIKE ?
      )
    `,a=[`%${t}%`,`%${t}%`];return i&&(n+=" AND project = ?",a.push(i)),n+=" ORDER BY created_at DESC LIMIT ?",a.push(e),this.db.prepare(n).all(...a).map(o=>({event:{id:o.id,session_id:o.session_id,project:o.project,tool_name:o.tool_name,tool_input:o.tool_input,tool_output:o.tool_output,cwd:o.cwd,created_at:o.created_at,files_touched:o.files_touched?JSON.parse(o.files_touched):void 0,event_type:o.event_type},distance:0}))}ensureEmbeddings(t=100){if(!this.lembedAvailable)return;let s=this.getEventsWithoutEmbeddings(t);for(let i of s){if(!i.id)continue;let e=this.getEmbeddableText(i),n=R("md5").update(e).digest("hex"),a=this.generateEmbedding(e);if(a)try{this.db.exec(`
            INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
            VALUES (${i.id}, x'${a.toString("hex")}')
          `),this.db.prepare(`
            INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
            VALUES (?, ?, ?)
          `).run(i.id,n,Date.now())}catch(r){console.warn(`[SimpleMemory] Failed to store embedding for event ${i.id}:`,r.message)}}}searchByVector(t,s={}){let{limit:i=20}=s,e=Buffer.from(new Float32Array(t).buffer);return this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(e,i).map(r=>({event:{id:r.id,session_id:r.session_id,project:r.project,tool_name:r.tool_name,tool_input:r.tool_input,tool_output:r.tool_output,cwd:r.cwd,created_at:r.created_at,files_touched:r.files_touched?JSON.parse(r.files_touched):void 0,event_type:r.event_type},distance:r.distance}))}storeEmbedding(t,s,i){let e=JSON.stringify(s);this.db.exec(`
      INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
      VALUES (${t}, '${e}')
    `),this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
      VALUES (?, ?, ?)
    `).run(t,i,Date.now())}hasEmbedding(t){return this.db.prepare("SELECT 1 FROM embedding_cache WHERE event_id = ?").get(t)!==void 0}getEventsWithoutEmbeddings(t=100){return this.db.prepare(`
      SELECT t.* FROM tool_events t
      LEFT JOIN embedding_cache c ON c.event_id = t.id
      WHERE c.event_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(t).map(e=>({id:e.id,session_id:e.session_id,project:e.project,tool_name:e.tool_name,tool_input:e.tool_input,tool_output:e.tool_output,cwd:e.cwd,created_at:e.created_at,files_touched:e.files_touched?JSON.parse(e.files_touched):void 0,event_type:e.event_type}))}formatContext(t){if(t.length===0)return"No recent activity found for this project.";let s=[`# Recent Activity
`],i=new Map;for(let e of t){let n=new Date(e.created_at).toLocaleDateString();i.has(n)||i.set(n,[]),i.get(n).push(e)}for(let[e,n]of i){s.push(`## ${e}
`);for(let a of n){let r=new Date(a.created_at).toLocaleTimeString(),c=a.files_touched?.join(", ")||"",o=c?` (${c})`:"";s.push(`- **${r}** [${a.tool_name}]${o}`);let l=a.tool_output.length>200?a.tool_output.slice(0,200)+"...":a.tool_output;l&&a.tool_name!=="Read"&&s.push(`  ${l.replace(/\n/g,`
  `)}`)}s.push("")}return s.join(`
`)}close(){this.db.close()}},p=null;function S(){return p||(p=new _),p}function I(d){let t=(d.match(/<private>/g)||[]).length,s=(d.match(/<claude-mem-context>/g)||[]).length;return t+s}function E(d){return typeof d!="string"?"{}":(I(d)>100&&console.error("[tag-stripping] Tag count exceeds limit"),d.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim())}var M=new Set(["TodoWrite","SlashCommand","Skill","AskUserQuestion","ExitPlanMode"]);function x(d){if(!d)return;let{session_id:t,cwd:s,tool_name:i,tool_input:e,tool_response:n}=d;if(M.has(i))return;let a=s?A.basename(s):"unknown-project";try{let r=typeof e=="string"?e:JSON.stringify(e),c=typeof n=="string"?n:JSON.stringify(n),o=E(r),l=E(c);if(!o&&!l)return;S().recordEvent({session_id:t,project:a,tool_name:i,tool_input:o,tool_output:l,cwd:s||"",created_at:Date.now()})}catch(r){console.error("[save-hook] Error:",r.message)}}var h="";v.on("data",d=>h+=d);v.on("end",()=>{let d=h?JSON.parse(h):void 0;x(d),console.log(JSON.stringify({continue:!0,suppressOutput:!0}))});
