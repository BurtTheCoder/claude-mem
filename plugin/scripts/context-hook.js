#!/usr/bin/env node
import J from"path";import{stdin as f}from"process";import F from"better-sqlite3";import*as v from"sqlite-vec";import*as b from"sqlite-lembed";import{homedir as S}from"os";import{join as E}from"path";import{mkdirSync as M,existsSync as T}from"fs";import{createHash as _}from"crypto";var x=384,u="all-MiniLM-L6-v2",A=E(S(),".claude-mem","models","all-MiniLM-L6-v2.gguf"),h=class{db;dataDir;modelPath;lembedAvailable=!1;constructor(e={}){let n=typeof e=="string"?{dataDir:e}:e;this.dataDir=n.dataDir||E(S(),".claude-mem"),this.modelPath=n.modelPath||A,T(this.dataDir)||M(this.dataDir,{recursive:!0});let s=E(this.dataDir,"simple-memory.db");this.db=new F(s),v.load(this.db);try{b.load(this.db),this.initLembed()}catch(t){console.warn("[SimpleMemory] sqlite-lembed not available, semantic search disabled:",t.message)}this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("cache_size = 10000"),this.initSchema()}initLembed(){if(!T(this.modelPath)){console.warn(`[SimpleMemory] Model not found at ${this.modelPath}`),console.warn("[SimpleMemory] Download with: curl -L -o ~/.claude-mem/models/all-MiniLM-L6-v2.gguf https://huggingface.co/asg017/sqlite-lembed-model-examples/resolve/main/all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf");return}try{this.db.exec(`
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
          embedding float[${x}]
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
    `);try{this.db.exec("ALTER TABLE preload_files ADD COLUMN source TEXT DEFAULT 'file'")}catch{}}startSession(e,n,s){this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project, user_prompt, started_at)
      VALUES (?, ?, ?, ?)
    `).run(e,n,s,Date.now())}endSession(e){this.db.prepare(`
      UPDATE sessions SET ended_at = ? WHERE id = ?
    `).run(Date.now(),e)}recordEvent(e){let n=this.extractMetadata(e);return this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.session_id,e.project,e.tool_name,e.tool_input,e.tool_output,e.cwd,e.created_at||Date.now(),n.files_touched?JSON.stringify(n.files_touched):null,n.event_type).lastInsertRowid}extractMetadata(e){let n=[],s="other";switch(e.tool_name){case"Read":s="read";try{let t=JSON.parse(e.tool_input);t.file_path&&n.push(t.file_path)}catch{}break;case"Write":case"Edit":case"MultiEdit":s="write";try{let t=JSON.parse(e.tool_input);t.file_path&&n.push(t.file_path)}catch{}break;case"Bash":s="exec";break;case"Glob":case"Grep":s="search";try{let t=JSON.parse(e.tool_input);t.path&&n.push(t.path)}catch{}break;default:s="other"}return{files_touched:n,event_type:s}}getRecentEvents(e,n=50){return this.db.prepare(`
      SELECT * FROM tool_events
      WHERE project = ?
        AND (event_type IS NULL OR event_type != 'preload')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(e,n).map(i=>({id:i.id,session_id:i.session_id,project:i.project,tool_name:i.tool_name,tool_input:i.tool_input,tool_output:i.tool_output,cwd:i.cwd,created_at:i.created_at,files_touched:i.files_touched?JSON.parse(i.files_touched):void 0,event_type:i.event_type}))}getEmbeddableText(e){let n=[];n.push(`[${e.tool_name}]`);try{let t=JSON.parse(e.tool_input);t.file_path&&n.push(t.file_path),t.pattern&&n.push(t.pattern),t.query&&n.push(t.query),t.command&&n.push(t.command)}catch{let t=e.tool_input.slice(0,500);n.push(t)}let s=e.tool_output.slice(0,1e3);return n.push(s),n.join(" ")}generateEmbedding(e){if(!this.lembedAvailable)return null;try{return this.db.prepare(`SELECT lembed('${u}', ?) as embedding`).get(e)?.embedding||null}catch(n){return console.warn("[SimpleMemory] Embedding generation failed:",n.message),null}}searchEvents(e,n={}){let{project:s,limit:t=20,semantic:i=!0}=n;return i&&this.lembedAvailable?this.semanticSearch(e,{project:s,limit:t}):this.textSearch(e,{project:s,limit:t})}semanticSearch(e,n){let{project:s,limit:t=20}=n;this.ensureEmbeddings(t*2);let i=this.generateEmbedding(e);if(!i)return this.textSearch(e,{project:s,limit:t});let a=this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(i,t*2);return(s?a.filter(r=>r.project===s).slice(0,t):a.slice(0,t)).map(r=>({event:{id:r.id,session_id:r.session_id,project:r.project,tool_name:r.tool_name,tool_input:r.tool_input,tool_output:r.tool_output,cwd:r.cwd,created_at:r.created_at,files_touched:r.files_touched?JSON.parse(r.files_touched):void 0,event_type:r.event_type},distance:r.distance}))}textSearch(e,n){let{project:s,limit:t=20}=n,i=`
      SELECT * FROM tool_events
      WHERE (
        tool_input LIKE ? OR
        tool_output LIKE ?
      )
    `,o=[`%${e}%`,`%${e}%`];return s&&(i+=" AND project = ?",o.push(s)),i+=" ORDER BY created_at DESC LIMIT ?",o.push(t),this.db.prepare(i).all(...o).map(r=>({event:{id:r.id,session_id:r.session_id,project:r.project,tool_name:r.tool_name,tool_input:r.tool_input,tool_output:r.tool_output,cwd:r.cwd,created_at:r.created_at,files_touched:r.files_touched?JSON.parse(r.files_touched):void 0,event_type:r.event_type},distance:0}))}ensureEmbeddings(e=100){if(!this.lembedAvailable)return;let n=this.getEventsWithoutEmbeddings(e);for(let s of n){if(!s.id)continue;let t=this.getEmbeddableText(s),i=_("md5").update(t).digest("hex"),o=this.generateEmbedding(t);if(o)try{this.db.exec(`
            INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
            VALUES (${s.id}, x'${o.toString("hex")}')
          `),this.db.prepare(`
            INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
            VALUES (?, ?, ?)
          `).run(s.id,i,Date.now())}catch(a){console.warn(`[SimpleMemory] Failed to store embedding for event ${s.id}:`,a.message)}}}searchByVector(e,n={}){let{limit:s=20}=n,t=Buffer.from(new Float32Array(e).buffer);return this.db.prepare(`
      SELECT e.event_id, e.distance, t.*
      FROM event_embeddings e
      JOIN tool_events t ON t.id = e.event_id
      WHERE e.embedding MATCH ? AND k = ?
      ORDER BY e.distance
    `).all(t,s).map(a=>({event:{id:a.id,session_id:a.session_id,project:a.project,tool_name:a.tool_name,tool_input:a.tool_input,tool_output:a.tool_output,cwd:a.cwd,created_at:a.created_at,files_touched:a.files_touched?JSON.parse(a.files_touched):void 0,event_type:a.event_type},distance:a.distance}))}storeEmbedding(e,n,s){let t=JSON.stringify(n);this.db.exec(`
      INSERT OR REPLACE INTO event_embeddings(event_id, embedding)
      VALUES (${e}, '${t}')
    `),this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (event_id, text_hash, created_at)
      VALUES (?, ?, ?)
    `).run(e,s,Date.now())}hasEmbedding(e){return this.db.prepare("SELECT 1 FROM embedding_cache WHERE event_id = ?").get(e)!==void 0}getEventsWithoutEmbeddings(e=100){return this.db.prepare(`
      SELECT t.* FROM tool_events t
      LEFT JOIN embedding_cache c ON c.event_id = t.id
      WHERE c.event_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(e).map(t=>({id:t.id,session_id:t.session_id,project:t.project,tool_name:t.tool_name,tool_input:t.tool_input,tool_output:t.tool_output,cwd:t.cwd,created_at:t.created_at,files_touched:t.files_touched?JSON.parse(t.files_touched):void 0,event_type:t.event_type}))}formatContext(e){if(e.length===0)return"No recent activity found for this project.";let n=[`# Recent Activity
`],s=new Map;for(let t of e){let i=new Date(t.created_at).toLocaleDateString();s.has(i)||s.set(i,[]),s.get(i).push(t)}for(let[t,i]of s){n.push(`## ${t}
`);for(let o of i){let a=new Date(o.created_at).toLocaleTimeString(),l=o.files_touched?.join(", ")||"",r=l?` (${l})`:"";n.push(`- **${a}** [${o.tool_name}]${r}`);let c=o.tool_output.length>200?o.tool_output.slice(0,200)+"...":o.tool_output;c&&o.tool_name!=="Read"&&n.push(`  ${c.replace(/\n/g,`
  `)}`)}n.push("")}return n.join(`
`)}getPreloadFiles(e){return this.db.prepare(`
      SELECT file_path as path, file_hash as hash, event_id
      FROM preload_files
      WHERE project = ?
    `).all(e)}importPreloadFile(e,n,s,t,i,o){let a=this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),l=JSON.stringify({source:"preload",path:n,title:t,category:i||null}),r=a.run(`preload-${e}`,e,"PreloadedKnowledge",l,o,"",Date.now(),JSON.stringify([n]),"preload"),c=Number(r.lastInsertRowid);return this.db.prepare(`
      INSERT OR REPLACE INTO preload_files (
        project, file_path, file_hash, title, category, event_id, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,n,s,t,i||null,c,Date.now()),c}updatePreloadFile(e,n,s,t,i,o,a){return a&&(this.db.prepare("DELETE FROM tool_events WHERE id = ?").run(a),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(a),this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(a)),this.importPreloadFile(e,n,s,t,i,o)}removeStalePreloadFiles(e,n){let s=this.getPreloadFiles(e),t=new Set(n),i=0;for(let o of s)t.has(o.path)||(o.event_id&&(this.db.prepare("DELETE FROM tool_events WHERE id = ?").run(o.event_id),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(o.event_id),this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(o.event_id)),this.db.prepare("DELETE FROM preload_files WHERE project = ? AND file_path = ?").run(e,o.path),i++);return i}getPreloadEvents(e){return this.db.prepare(`
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
         ORDER BY p.imported_at DESC`,s=this.db.prepare(n);return(e?s.all(e):s.all()).map(i=>({id:i.id,project:i.project,file_path:i.file_path,title:i.title,category:i.category,source:i.source||"file",imported_at:i.imported_at,content_preview:i.content_preview||""}))}getPreloadById(e){let s=this.db.prepare(`
      SELECT p.*, t.tool_output as content
      FROM preload_files p
      LEFT JOIN tool_events t ON t.id = p.event_id
      WHERE p.id = ?
    `).get(e);return s?{id:s.id,project:s.project,file_path:s.file_path,title:s.title,category:s.category,source:s.source||"file",imported_at:s.imported_at,content:s.content||""}:null}createPreload(e,n,s,t){let i=_("md5").update(t).digest("hex"),o=`ui:${n.toLowerCase().replace(/\s+/g,"-")}-${Date.now()}`,a=`preload-${e}`;this.startSession(a,e,"Preloaded Knowledge");let l=this.db.prepare(`
      INSERT INTO tool_events (
        session_id, project, tool_name, tool_input, tool_output,
        cwd, created_at, files_touched, event_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),r=JSON.stringify({source:"ui",path:o,title:n,category:s}),c=l.run(a,e,"PreloadedKnowledge",r,t,"",Date.now(),JSON.stringify([o]),"preload"),p=Number(c.lastInsertRowid),D=this.db.prepare(`
      INSERT INTO preload_files (
        project, file_path, file_hash, title, category, event_id, imported_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ui')
    `).run(e,o,i,n,s,p,Date.now());return Number(D.lastInsertRowid)}updatePreload(e,n,s,t){let i=this.getPreloadById(e);if(!i)throw new Error("Preload not found");if(i.source==="file")throw new Error("Cannot update file-based preloads");let o=_("md5").update(t).digest("hex"),a=this.db.prepare(`
      UPDATE tool_events
      SET tool_input = ?, tool_output = ?, created_at = ?
      WHERE id = (SELECT event_id FROM preload_files WHERE id = ?)
    `),l=JSON.stringify({source:"ui",path:i.file_path,title:n,category:s});a.run(l,t,Date.now(),e),this.db.prepare(`
      UPDATE preload_files
      SET title = ?, category = ?, file_hash = ?, imported_at = ?
      WHERE id = ?
    `).run(n,s,o,Date.now(),e);let p=this.db.prepare("SELECT event_id FROM preload_files WHERE id = ?").get(e);p?.event_id&&(this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(p.event_id),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(p.event_id))}deletePreload(e){let n=this.getPreloadById(e);if(!n)throw new Error("Preload not found");if(n.source==="file")throw new Error("Cannot delete file-based preloads");let t=this.db.prepare("SELECT event_id FROM preload_files WHERE id = ?").get(e);t?.event_id&&(this.db.prepare("DELETE FROM tool_events WHERE id = ?").run(t.event_id),this.db.prepare("DELETE FROM embedding_cache WHERE event_id = ?").run(t.event_id),this.db.prepare("DELETE FROM event_embeddings WHERE event_id = ?").run(t.event_id)),this.db.prepare("DELETE FROM preload_files WHERE id = ?").run(e)}close(){this.db.close()}},m=null;function g(){return m||(m=new h),m}import{createHash as C}from"crypto";import{existsSync as R,readdirSync as P,readFileSync as j}from"fs";import{join as N,relative as U,basename as X,extname as O}from"path";function w(d){let e=N(d,".claude-mem","preload");return R(e)?e:null}function L(d,e=d){let n=[];if(!R(d))return n;let s=P(d,{withFileTypes:!0});for(let t of s){let i=N(d,t.name);if(t.isDirectory())n.push(...L(i,e));else if(t.isFile()){let o=O(t.name).toLowerCase();(o===".md"||o===".markdown"||o===".txt")&&n.push(i)}}return n}function H(d,e){let n=d.match(/^#\s+(.+)$/m);if(n)return n[1].trim();let s=d.match(/^---\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/);return s?s[1].trim().replace(/^["']|["']$/g,""):X(e,O(e)).replace(/[-_]/g," ").replace(/\b\w/g,t=>t.toUpperCase())}function W(d){let e=d.split("/");if(e.length>1)return e[0].replace(/[-_]/g," ").replace(/\b\w/g,n=>n.toUpperCase())}function $(d,e){let n=j(d,"utf-8"),s=U(e,d),t=C("md5").update(n).digest("hex");return{path:s,absolutePath:d,content:n,hash:t,title:H(n,d),category:W(s)}}function y(d){let e=w(d);return e?{files:L(e).map(t=>$(t,e)),preloadDir:e}:null}function B(d,e){let n={added:0,updated:0,removed:0};try{let s=y(d);if(!s||s.files.length===0)return n;let t=g(),i=t.getPreloadFiles(e),o=new Map(i.map(l=>[l.path,l]));for(let l of s.files){let r=o.get(l.path);r?r.hash!==l.hash&&(t.updatePreloadFile(e,l.path,l.hash,l.title,l.category,l.content,r.event_id),n.updated++):(t.importPreloadFile(e,l.path,l.hash,l.title,l.category,l.content),n.added++)}let a=s.files.map(l=>l.path);return n.removed=t.removeStalePreloadFiles(e,a),n}catch(s){return console.error("[context-hook] Preload sync error:",s.message),n}}function I(d){let e=d?.cwd??process.cwd(),n=e?J.basename(e):"unknown-project";try{let s=g();d?.session_id&&s.startSession(d.session_id,n,"");let t=B(e,n);(t.added>0||t.updated>0||t.removed>0)&&console.error(`[claude-mem] Preload indexed: +${t.added} ~${t.updated} -${t.removed} files`);let i=s.getRecentEvents(n,50);return i.length===0?"":`<claude-mem-context>
${s.formatContext(i)}
</claude-mem-context>`}catch(s){return console.error("[context-hook] Error:",s.message),""}}var Y=process.argv.includes("--colors");if(f.isTTY||Y){let d=I(void 0);console.log(d),process.exit(0)}else{let d="";f.on("data",e=>d+=e),f.on("end",()=>{let e=d.trim()?JSON.parse(d):void 0,n=I(e);console.log(JSON.stringify(n?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:n}}:{continue:!0,suppressOutput:!0})),process.exit(0)})}
