require("dotenv").config();
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { OAuth2Client } = require("google-auth-library");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const db = new Database(process.env.DB_PATH || "cane-ai.sqlite");
const JWT_SECRET = process.env.JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:3000";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Imposta JWT_SECRET con almeno 32 caratteri in .env");
  process.exit(1);
}
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT,
 google_sub TEXT UNIQUE,display_name TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations(
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,title TEXT DEFAULT 'Nuova conversazione',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS messages(
 id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id INTEGER NOT NULL,role TEXT NOT NULL,
 content TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS memories(
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,content TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id)
);
`);
app.use(helmet({contentSecurityPolicy:false,crossOriginOpenerPolicy:{policy:"same-origin-allow-popups"}}));
app.use(express.json({limit:"4mb"}));
app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(req,res)=>res.json({ok:true,service:"cane-ai"}));
app.use("/api/",rateLimit({windowMs:60*1000,limit:90,standardHeaders:true,legacyHeaders:false}));

function sign(user){return jwt.sign({sub:user.id},JWT_SECRET,{expiresIn:"7d"});}
function auth(req,res,next){
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 try{req.userId=jwt.verify(token,JWT_SECRET).sub;next();}
 catch{return res.status(401).json({error:"Sessione scaduta. Accedi di nuovo."});}
}
function apiKey(res){if(!OPENAI_API_KEY){res.status(503).json({error:"Servizio AI non configurato: aggiungi OPENAI_API_KEY al file .env."});return false;}return true;}
async function openai(pathname,opts={}){
 const r=await fetch("https://api.openai.com"+pathname,{...opts,headers:{
  Authorization:"Bearer "+OPENAI_API_KEY,
  ...(opts.body?{"Content-Type":"application/json"}:{}),...(opts.headers||{})
 }});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error(data.error?.message||"Errore del provider AI");
 return data;
}
app.post("/api/register",async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");
 if(!/^\S+@\S+\.\S+$/.test(email)||password.length<10)return res.status(400).json({error:"Email non valida o password inferiore a 10 caratteri."});
 try{
  const hash=await bcrypt.hash(password,12);
  const info=db.prepare("INSERT INTO users(email,password_hash,display_name) VALUES(?,?,?)").run(email,hash,email.split("@")[0]);
  const user={id:Number(info.lastInsertRowid),email,display_name:email.split("@")[0]};
  res.json({token:sign(user),user});
 }catch(e){if(e.code==="SQLITE_CONSTRAINT_UNIQUE")return res.status(409).json({error:"Questa email è già registrata."});console.error("Registrazione:",e.message);return res.status(500).json({error:"Registrazione non riuscita."});}
});
app.post("/api/login",async(req,res)=>{
 const email=String(req.body.email||"").trim().toLowerCase(),u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
 if(!u||!u.password_hash||!(await bcrypt.compare(String(req.body.password||""),u.password_hash)))return res.status(401).json({error:"Credenziali non corrette."});
 res.json({token:sign(u),user:{id:u.id,email:u.email,display_name:u.display_name}});
});
app.post("/api/google",async(req,res)=>{
 if(!GOOGLE_CLIENT_ID)return res.status(503).json({error:"Accedi con Google non configurato: imposta GOOGLE_CLIENT_ID."});
 try{
  const ticket=await googleClient.verifyIdToken({idToken:String(req.body.credential||""),audience:GOOGLE_CLIENT_ID});
  const p=ticket.getPayload(); if(!p?.sub||!p.email_verified) return res.status(401).json({error:"Identità Google non verificata."});
  let u=db.prepare("SELECT * FROM users WHERE google_sub=? OR email=?").get(p.sub,p.email.toLowerCase());
  if(u){db.prepare("UPDATE users SET google_sub=COALESCE(google_sub,?),display_name=? WHERE id=?").run(p.sub,p.name||p.email,u.id);}
  else {const info=db.prepare("INSERT INTO users(email,google_sub,display_name) VALUES(?,?,?)").run(p.email.toLowerCase(),p.sub,p.name||p.email);u={id:Number(info.lastInsertRowid),email:p.email};}
  res.json({token:sign(u),user:{id:u.id,email:p.email,display_name:p.name||p.email}});
 }catch{return res.status(401).json({error:"Accesso Google non riuscito."});}
});
app.get("/api/me",auth,(req,res)=>{
 const u=db.prepare("SELECT id,email,display_name FROM users WHERE id=?").get(req.userId);
 res.json({user:u,memories:db.prepare("SELECT id,content,created_at FROM memories WHERE user_id=? ORDER BY id DESC").all(req.userId)});
});
app.get("/api/conversations",auth,(req,res)=>{
 res.json(db.prepare("SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 50").all(req.userId));
});
app.post("/api/conversations",auth,(req,res)=>{
 const title=String(req.body.title||"Nuova conversazione").slice(0,100);
 const info=db.prepare("INSERT INTO conversations(user_id,title) VALUES(?,?)").run(req.userId,title);
 res.json({id:Number(info.lastInsertRowid),title});
});
app.get("/api/conversations/:id",auth,(req,res)=>{
 const c=db.prepare("SELECT id,title FROM conversations WHERE id=? AND user_id=?").get(req.params.id,req.userId);
 if(!c)return res.status(404).json({error:"Conversazione non trovata."});
 res.json({conversation:c,messages:db.prepare("SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY id").all(c.id)});
});
app.delete("/api/conversations/:id",auth,(req,res)=>{
 db.prepare("DELETE FROM messages WHERE conversation_id=? AND conversation_id IN (SELECT id FROM conversations WHERE id=? AND user_id=?)").run(req.params.id,req.params.id,req.userId);
 db.prepare("DELETE FROM conversations WHERE id=? AND user_id=?").run(req.params.id,req.userId);res.json({ok:true});
});
app.post("/api/chat",auth,async(req,res)=>{
 if(!apiKey(res))return;
 const content=String(req.body.message||"").trim().slice(0,10000),cid=Number(req.body.conversationId);
 if(!content)return res.status(400).json({error:"Messaggio vuoto."});
 let c=cid?db.prepare("SELECT id FROM conversations WHERE id=? AND user_id=?").get(cid,req.userId):null;
 if(!c){const info=db.prepare("INSERT INTO conversations(user_id,title) VALUES(?,?)").run(req.userId,content.slice(0,64));c={id:Number(info.lastInsertRowid)};}
 const memoryRows=db.prepare("SELECT content FROM memories WHERE user_id=? ORDER BY id DESC LIMIT 20").all(req.userId);
 const prior=db.prepare("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 16").all(c.id).reverse();
 try{
  const result=await openai("/v1/responses",{method:"POST",body:JSON.stringify({
   model:"gpt-4.1-mini",
   instructions:"Sei Cane AI, un assistente utile, affidabile e amichevole. Rispondi in italiano quando l'utente scrive in italiano. Memorie esplicite dell'utente (usa solo se pertinenti): "+memoryRows.map(x=>x.content).join(" | "),
   input:[...prior.map(m=>({role:m.role,content:m.content})),{role:"user",content}]
  })});
  const reply=result.output?.flatMap(x=>x.content||[]).filter(x=>x.type==="output_text").map(x=>x.text).join("\n")||"Non ho una risposta disponibile.";
  db.prepare("INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)").run(c.id,"user",content);
  db.prepare("INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)").run(c.id,"assistant",reply);
  db.prepare("UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(c.id);
  res.json({reply,conversationId:c.id});
 }catch(e){console.error("Chat AI:",e.message);res.status(502).json({error:"La richiesta AI non è riuscita. Controlla chiave API, accesso al modello e fatturazione."});}
});
app.post("/api/memories",auth,(req,res)=>{
 const content=String(req.body.content||"").trim().slice(0,500);
 if(!content)return res.status(400).json({error:"Scrivi una memoria."});
 const info=db.prepare("INSERT INTO memories(user_id,content) VALUES(?,?)").run(req.userId,content);
 res.json({id:Number(info.lastInsertRowid),content});
});
app.delete("/api/memories/:id",auth,(req,res)=>{
 db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(req.params.id,req.userId);res.json({ok:true});
});
app.post("/api/image",auth,async(req,res)=>{
 if(!apiKey(res))return;
 try{const d=await openai("/v1/images/generations",{method:"POST",body:JSON.stringify({model:"gpt-image-1",prompt:String(req.body.prompt||"").slice(0,2000),size:"1024x1024"})});res.json({image:d.data?.[0]?.b64_json?"data:image/png;base64,"+d.data[0].b64_json:null});}
 catch(e){res.status(502).json({error:e.message});}
});
app.post("/api/video",auth,async(req,res)=>{
 if(!apiKey(res))return;
 const prompt=String(req.body.prompt||"").trim().slice(0,4000);
 if(!prompt)return res.status(400).json({error:"Inserisci una descrizione del video."});
 try{const d=await openai("/v1/videos",{method:"POST",body:JSON.stringify({model:"sora-2",prompt,seconds:String(req.body.seconds||"8"),size:req.body.size||"1280x720"})});res.json({id:d.id,status:d.status||"queued"});}
 catch(e){res.status(502).json({error:"Video non avviato: "+e.message});}
});
app.get("/api/video/:id",auth,async(req,res)=>{
 if(!apiKey(res))return;
 try{const d=await openai("/v1/videos/"+encodeURIComponent(req.params.id));res.json({id:d.id,status:d.status,progress:d.progress||0,error:d.error||null});}
 catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/video/:id/content",auth,async(req,res)=>{
 if(!apiKey(res))return;
 try{
  const r=await fetch("https://api.openai.com/v1/videos/"+encodeURIComponent(req.params.id)+"/content",{headers:{Authorization:"Bearer "+OPENAI_API_KEY}});
  if(!r.ok)return res.status(r.status).json({error:"Video non ancora disponibile."});
  res.setHeader("Content-Type",r.headers.get("content-type")||"video/mp4");res.setHeader("Cache-Control","private, no-store");
  for await (const chunk of r.body) res.write(Buffer.from(chunk));
  res.end();
 }catch(e){res.status(502).json({error:e.message});}
});
app.post("/api/voice/session",auth,async(req,res)=>{
 if(!apiKey(res))return;
 try{
  const d=await openai("/v1/realtime/client_secrets",{method:"POST",body:JSON.stringify({session:{type:"realtime",model:"gpt-realtime-2.1",audio:{output:{voice:"marin"}},instructions:"Sei Cane AI. Parla in italiano se l'utente parla italiano."}})});
  res.json({client_secret:d.value||d.client_secret?.value,expires_at:d.expires_at});
 }catch(e){res.status(502).json({error:"Sessione vocale non disponibile: "+e.message});}
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log("Cane AI 2.0 su "+APP_ORIGIN+" (porta "+port+")"));
