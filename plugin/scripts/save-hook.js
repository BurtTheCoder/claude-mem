#!/usr/bin/env node
import M from"path";import{stdin as N}from"process";import L from"better-sqlite3";import*as b from"sqlite-vec";import*as v from"sqlite-lembed";import{homedir as S}from"os";import{join as m}from"path";import{mkdirSync as y,existsSync as f}from"fs";import{createHash as _}from"crypto";var I=384,u="all-MiniLM-L6-v2",D=m(S(),".claude-mem","models","all-MiniLM-L6-v2.gguf"),h=class{db;dataDir;modelPath;lembedAvailable=!1;constructor(e={}){let n=typeof e=="string"?{dataDir:e}:e;this.dataDir=n.dataDir||m(S(),".claude-mem"),this.modelPath=n.modelPath||D,f(this.dataDir)||y(this.dataDir,{recursive:!0});let i=m(this.dataDir,"simple-memory.db");this.db=new L(i),b.load(this.db);try{v.load(this.db),this.initLembed()}catch(t){console.warn("[SimpleMemory] sqlite-lembed not available, semantic search disabled:",t.message)}this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("cache_size = 10000"),this.initSchema()}initLembed(){if(!f(this.modelPath)){console.warn(`[SimpleMemory] Model not found at ${this.modelPath}`),console.warn("[SimpleMemory] Download with: curl -L -o ~/.claude-mem/models/all-MiniLM-L6-v2.gguf https://huggingface.co/asg017/sqlite-lembed-model-examples/resolve/main/all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf");return}try{this.db.exec(`
        INSERT INTO temp.lembed_models(name, model)
        SELECT '${u}', lembed_model_from_file('${this.modelPath}')
        WHERE NOT EXISTS (SELECT 1 FROM temp.lembed_models WHERE name = '${u}')
      `),this.lembedAvailable=!0,console.log("[SimpleMemory] sqlite-lembed initialized with",u)}catch(e){console.warn("[SimpleMemory] Failed to register embedding model:",e.message)}}isSemanticSearchAvailable(){return this.lembedAvailable}initSchema(){this.db.exec(`
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
          embedding float[${I}]
        );
      `)}catch(e){if(!e.message.includes("already exists"))throw e}this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        event_id INTEGER PRIMARY KEY,
        text_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(event_id) REFERENCES tool_events(id) ON DELETE CASCADE
      );
    `),this.db.exec(`
      CREATE TABLE IF NOT EXISTS preload_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        title TEXT,
        category TEXT,
        event_id INTEGER,
        imported_at INTEGER NOT NULL,
        source TEXT DEFAULT 'file',
        UNIQUE(project, file_path),
        FOREIGN KEY(event_id) REFERENCES tool_events(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_preload_project ON preload_files(project);
    `);try{this.db.exec("ALTER TABLE preload_files ADD COLUMN source TEXT DEFAULT 'file'")}catch{}}startSession(e,n,i){this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project, user_prompt, started_at)
      VALUES (?, ?, ?, ?)
    `).run(e,n,i,Date.now())}endSession(e){this.db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ?
    `).run(Date.now(),e)}recordEvent(e){let n=this.extractMetadata(e);return this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.session_id,e.project,e.tool_name,e.tool_input,e.tool_output,e.cwd,e.created_at||Date.now(),n.files_touched?JSON.stringify(n.files_touched):null,n.event_type).lastInsertRowid}extractMetadata(e){let n=[],i="other";switch(e.tool_name){case"Read":i="read";try{let t=JSON.parse(e.tool_input);t.file_path&&n.push(t.file_path)}catch{}break;case"Write":case"Edit":case"MultiEdit":i="write";try{let t=JSON.parse(e.tool_input);t.file_path&&n.push(t.file_path)}catch{}break;case"Bash":i="exec";break;case"Glob":case"Grep":i="search";try{let t=JSON.parse(e.tool_input);t.path&&n.push(t.path)}catch{}break;default:i="other"}return{files_touched:n,event_type:i}}getRecentEvents(e,n=50){return this.db.prepare(`
      SELECT * FROM tool_events
      WHERE project = ?
        AND (event_type IS NULL OR event_type != 'preload')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(e,n).map(s=>({id:s.id,session_id:s.session_id,project:s.project,tool_name:s.tool_name,tool_input:s.tool_input,tool_output:s.tool_output,cwd:s.cwd,created_at:s.created_at,files_touched:s.files_touched?JSON.parse(s.files_touched):void 0,event_type:s.event_type}))}getEmbeddableText(e){let n=[];n.push(`[${e.tool_name}]`);try{let t=JSON.parse(e.tool_input);t.file_path&&n.push(t.file_path),t.pattern&&n.push(t.pattern),t.query&&n.push(t.query),t.command&&n.push(t.command)}catch{let t=e.tool_input.slice(0,500);n.push(t)}let i=e.tool_output.slice(0,1e3);return n.push(i),n.join(" ")}generateEmbedding(e){if(!this.lembedAvailable)return null;try{return this.db.prepare(`SELECT lembed('${u}', ?) as embedding`).get(e)?.embedding||null}catch(n){return console.warn("[SimpleMemory] Embedding generation failed:",n.message),null}}searchEvents(e,n={}){let{project:i,limit:t=20,semantic:s=!0}=n;return s&&this.lembedAvailable?this.semanticSearch(e,{project:i,limit:t}):this.textSearch(e,{project:i,limit:t})}semanticSearch(e,n){let{project:i,limit:t=20}=n;this.ensureEmbeddings(t*2);let s=this.generateEmbedding(e);if(!s)return this.textSearch(e,{project:i,limit:t});let o=this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(s,t*2);return(i?o.filter(r=>r.project===i).slice(0,t):o.slice(0,t)).map(r=>({event:{id:r.id,session_id:r.session_id,project:r.project,tool_name:r.tool_name,tool_input:r.tool_input,tool_output:r.tool_output,cwd:r.cwd,created_at:r.created_at,files_touched:r.files_touched?JSON.parse(r.files_touched):void 0,event_type:r.event_type},distance:r.distance}))}textSearch(e,n){let{project:i,limit:t=20}=n,s=`
      SELECT * FROM tool_events
      WHERE (
        tool_input LIKE ? OR
        tool_output LIKE ?
      )
    `,a=[`%${e}%`,`%${e}%`];return i&&(s+=" AND project = ?",a.push(i)),s+=" ORDER BY created_at DESC LIMIT ?",a.push(t),this.db.prepare(s).all(...a).map(r=>({event:{id:r.id,session_id:r.session_id,project:r.project,tool_name:r.tool_name,tool_input:r.tool_input,tool_output:r.tool_output,cwd:r.cwd,created_at:r.created_at,files_touched:r.files_touched?JSON.parse(r.files_touched):void 0,event_type:r.event_type},distance:0}))}ensureEmbeddings(e=100){if(!this.lembedAvailable)return;let n=this.getEventsWithoutEmbeddings(e);for(let i of n){if(!i.id)continue;let t=this.getEmbeddableText(i),s=_("md5").update(t).digest("hex"),a=this.generateEmbedding(t);if(a)try{this.db.exec(`
            INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
            VALUES (${i.id}, x'${a.toString("hex")}')
          `),this.db.prepare(`
            INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
            VALUES (?, ?, ?)
          `).run(i.id,s,Date.now())}catch(o){console.warn(`[SimpleMemory] Failed to store embedding for event ${i.id}:`,o.message)}}}searchByVector(e,n={}){let{limit:i=20}=n,t=Buffer.from(new Float32Array(e).buffer);return this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(t,i).map(o=>({event:{id:o.id,session_id:o.session_id,project:o.project,tool_name:o.tool_name,tool_input:o.tool_input,tool_output:o.tool_output,cwd:o.cwd,created_at:o.created_at,files_touched:o.files_touched?JSON.parse(o.files_touched):void 0,event_type:o.event_type},distance:o.distance}))}storeEmbedding(e,n,i){let t=JSON.stringify(n);this.db.exec(`
      INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
      VALUES (${e}, '${t}')
    `),this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
      VALUES (?, ?, ?)
    `).run(e,i,Date.now())}hasEmbedding(e){return this.db.prepare("SELECT 1 FROM embedding_cache WHERE event_id = ?").get(e)!==void 0}getEventsWithoutEmbeddings(e=100){return this.db.prepare(`
      SELECT t.* FROM tool_events t
      LEFT JOIN embedding_cache c ON c.event_id = t.id
      WHERE c.event_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(e).map(t=>({id:t.id,session_id:t.session_id,project:t.project,tool_name:t.tool_name,tool_input:t.tool_input,tool_output:t.tool_output,cwd:t.cwd,created_at:t.created_at,files_touched:t.files_touched?JSON.parse(t.files_touched):void 0,event_type:t.event_type}))}formatContext(e){if(e.length===0)return"No recent activity found for this project.";let n=[`# Recent Activity
`],i=new Map;for(let t of e){let s=new Date(t.created_at).toLocaleDateString();i.has(s)||i.set(s,[]),i.get(s).push(t)}for(let[t,s]of i){n.push(`## ${t}
`);for(let a of s){let o=new Date(a.created_at).toLocaleTimeString(),l=a.files_touched?.join(", ")||"",r=l?` (${l})`:"";n.push(`- **${o}** [${a.tool_name}]${r}`);let c=a.tool_output.length>200?a.tool_output.slice(0,200)+"...":a.tool_output;c&&a.tool_name!=="Read"&&n.push(`  ${c.replace(/\n/g,`
  `)}`)}n.push("")}return n.join(`
`)}getPreloadFiles(e){return this.db.prepare(`
      SELECT file_path as path, file_hash as hash, event_id
      FROM preload_files
      WHERE project = ?
    `).all(e)}importPreloadFile(e,n,i,t,s,a){let o=this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),l=JSON.stringify({source:"preload",path:n,title:t,category:s||null}),r=o.run(`preload-${e}`,e,"PreloadedKnowledge",l,a,"",Date.now(),JSON.stringify([n]),"preload"),c=Number(r.lastInsertRowid);return this.db.prepare(`
      INSERT OR REPLACE INTO preload_files (
        project, file_path, file_hash, title, category, event_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,n,i,t,s||null,c,Date.now()),c}updatePreloadFile(e,n,i,t,s,a,o){return o&&(this.db.prepare("DELETE FROM tool_events WHERE id = ?").run(o),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(o),this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(o)),this.importPreloadFile(e,n,i,t,s,a)}removeStalePreloadFiles(e,n){let i=this.getPreloadFiles(e),t=new Set(n),s=0;for(let a of i)t.has(a.path)||(a.event_id&&(this.db.prepare("DELETE FROM tool_events WHERE id = ?").run(a.event_id),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(a.event_id),this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(a.event_id)),this.db.prepare("DELETE FROM preload_files WHERE project = ? AND file_path = ?").run(e,a.path),s++);return s}getPreloadEvents(e){return this.db.prepare(`
      SELECT t.* FROM tool_events t
      JOIN preload_files p ON p.event_id = t.id
      WHERE p.project = ?
      ORDER BY t.created_at DESC
    `).all(e).map(t=>({id:t.id,session_id:t.session_id,project:t.project,tool_name:t.tool_name,tool_input:t.tool_input,tool_output:t.tool_output,cwd:t.cwd,created_at:t.created_at,files_touched:t.files_touched?JSON.parse(t.files_touched):void 0,event_type:t.event_type}))}getAllPreloads(e){let n=e?`SELECT p.*, SUBSTR(t.tool_output, 1, 200) as content_preview
         FROM preload_files p
         LEFT JOIN tool_events t ON t.id = p.event_id
         WHERE p.project = ?
         ORDER BY p.imported_at DESC`:`SELECT p.*, SUBSTR(t.tool_output, 1, 200) as content_preview
         FROM preload_files p
         LEFT JOIN tool_events t ON t.id = p.event_id
         ORDER BY p.imported_at DESC`,i=this.db.prepare(n);return(e?i.all(e):i.all()).map(s=>({id:s.id,project:s.project,file_path:s.file_path,title:s.title,category:s.category,source:s.source||"file",imported_at:s.imported_at,content_preview:s.content_preview||""}))}getPreloadById(e){let i=this.db.prepare(`
      SELECT p.*, t.tool_output as content
      FROM preload_files p
      LEFT JOIN tool_events t ON t.id = p.event_id
      WHERE p.id = ?
    `).get(e);return i?{id:i.id,project:i.project,file_path:i.file_path,title:i.title,category:i.category,source:i.source||"file",imported_at:i.imported_at,content:i.content||""}:null}createPreload(e,n,i,t){let s=_("md5").update(t).digest("hex"),a=`ui:${n.toLowerCase().replace(/\s+/g,"-")}-${Date.now()}`,o=`preload-${e}`;this.startSession(o,e,"Preloaded Knowledge");let l=this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),r=JSON.stringify({source:"ui",path:a,title:n,category:i}),c=l.run(o,e,"PreloadedKnowledge",r,t,"",Date.now(),JSON.stringify([a]),"preload"),p=Number(c.lastInsertRowid),O=this.db.prepare(`
      INSERT INTO preload_files (
        project, file_path, file_hash, title, category, event_id, imported_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ui')
    `).run(e,a,s,n,i,p,Date.now());return Number(O.lastInsertRowid)}updatePreload(e,n,i,t){let s=this.getPreloadById(e);if(!s)throw new Error("Preload not found");if(s.source==="file")throw new Error("Cannot update file-based preloads");let a=_("md5").update(t).digest("hex"),o=this.db.prepare(`
      UPDATE tool_events
      SET tool_input = ?, tool_output = ?, created_at = ?
      WHERE id = (SELECT event_id FROM preload_files WHERE id = ?)
    `),l=JSON.stringify({source:"ui",path:s.file_path,title:n,category:i});o.run(l,t,Date.now(),e),this.db.prepare(`
      UPDATE preload_files
      SET title = ?, category = ?, file_hash = ?, imported_at = ?
      WHERE id = ?
    `).run(n,i,a,Date.now(),e);let p=this.db.prepare("SELECT event_id FROM preload_files WHERE id = ?").get(e);p?.event_id&&(this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(p.event_id),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(p.event_id))}deletePreload(e){let n=this.getPreloadById(e);if(!n)throw new Error("Preload not found");if(n.source==="file")throw new Error("Cannot delete file-based preloads");let t=this.db.prepare("SELECT event_id FROM preload_files WHERE id = ?").get(e);t?.event_id&&(this.db.prepare("DELETE FROM tool_events WHERE id = ?").run(t.event_id),this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(t.event_id),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(t.event_id)),this.db.prepare("DELETE FROM preload_files WHERE id = ?").run(e)}close(){this.db.close()}},E=null;function R(){return E||(E=new h),E}function A(d){let e=(d.match(/<private>/g)||[]).length,n=(d.match(/<claude-mem-context>/g)||[]).length;return e+n}function g(d){return typeof d!="string"?"{}":(A(d)>100&&console.error("[tag-stripping] Tag count exceeds limit"),d.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim())}var C=new Set(["TodoWrite","SlashCommand","Skill","AskUserQuestion","ExitPlanMode"]);function F(d){if(!d)return;let{session_id:e,cwd:n,tool_name:i,tool_input:t,tool_response:s}=d;if(C.has(i))return;let a=n?M.basename(n):"unknown-project";try{let o=typeof t=="string"?t:JSON.stringify(t),l=typeof s=="string"?s:JSON.stringify(s),r=g(o),c=g(l);if(!r&&!c)return;R().recordEvent({session_id:e,project:a,tool_name:i,tool_input:r,tool_output:c,cwd:n||"",created_at:Date.now()})}catch(o){console.error("[save-hook] Error:",o.message)}}var T="";N.on("data",d=>T+=d);N.on("end",()=>{let d=T?JSON.parse(T):void 0;F(d),console.log(JSON.stringify({continue:!0,suppressOutput:!0}))});
