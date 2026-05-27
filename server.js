const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { MongoClient } = require("mongodb");
const { syncDiaryToPks } = require("./pks-bridge");

const PORT = process.env.PORT || 8800;
const MONGO_URI = process.env.MONGO_URI || "mongodb://diary-user:diary123456@ac-qprtzc7-shard-00-00.embfjnb.mongodb.net:27017,ac-qprtzc7-shard-00-01.embfjnb.mongodb.net:27017,ac-qprtzc7-shard-00-02.embfjnb.mongodb.net:27017/diary?ssl=true&replicaSet=atlas-zyem06-shard-0&authSource=admin&retryWrites=true&w=majority";
const mime = { js:"text/javascript; charset=utf-8", html:"text/html; charset=utf-8", json:"application/json", png:"image/png", svg:"image/svg+xml" };

let db, entriesCol, statsCol, painpointsCol, settingsCol;

async function initDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("diary");
  entriesCol = db.collection("entries");
  statsCol = db.collection("stats");
  painpointsCol = db.collection("painpoints");
  settingsCol = db.collection("settings");
  await entriesCol.createIndex({ date: -1 });
  await entriesCol.createIndex({ createdAt: -1 });
  await painpointsCol.createIndex({ createdAt: -1 });
  console.log("MongoDB 连接成功");
}

async function getStats() {
  let s = await statsCol.findOne({ _id: "main" });
  if (!s) { s = { _id:"main", totalEntries:0, totalWords:0, streak:0, lastDate:"" }; await statsCol.insertOne(s); }
  return s;
}

async function updateStats(entries) {
  const totalEntries = entries.length;
  let totalWords = 0;
  entries.forEach(function(e) {
    totalWords += (e.content || "").length;
    (e.blocks || []).forEach(function(b) { totalWords += (b.content || "").length; });
  });
  var dates = [], seen = {};
  entries.forEach(function(e) { if (!seen[e.date]) { seen[e.date]=true; dates.push(e.date); } });
  dates.sort().reverse();
  var streak=0, today=new Date().toISOString().split("T")[0], checkDate=today;
  for (var i=0; i<dates.length; i++) {
    if (dates[i]===checkDate) { streak++; var dt=new Date(checkDate); dt.setDate(dt.getDate()-1); checkDate=dt.toISOString().split("T")[0]; }
    else if (dates[i]<checkDate) break;
  }
  await statsCol.updateOne({ _id:"main" }, { $set:{ totalEntries, totalWords, streak, lastDate:dates[0]||today } });
}

async function getSettings() {
  let s = await settingsCol.findOne({ _id: "main" });
  if (!s) {
    s = { _id:"main", theme:"dark", apiConfigs:[
      { name:"deepseek", key:"sk-fac4319337b9452190c29cc25103383a", model:"deepseek-chat", base:"https://api.deepseek.com/v1", enabled:true },
      { name:"xiaom", key:"tp-c3augjwy091yrm1k5lir7kr76edtfxjz3cq3rgpjus6caurx", model:"claude-sonnet-4-20250514", base:"https://api.xiaom.ai/v1", enabled:true }
    ], autoPainMatch:true };
    await settingsCol.insertOne(s);
  }
  return s;
}

async function getAIConfigs() {
  const s = await getSettings();
  return (s.apiConfigs || []).filter(function(c){ return c.enabled; });
}

function parseBody(req) {
  return new Promise(function(resolve) {
    let body = "";
    req.on("data", function(c) { body+=c; });
    req.on("end", function() { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function callAI(messages, config) {
  return new Promise(function(resolve) {
    const body = JSON.stringify({ model:config.model, messages, max_tokens:1024, temperature:0.7 });
    const u = new URL(config.base+"/chat/completions");
    const options = { hostname:u.hostname, port:u.port||443, path:u.pathname, method:"POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer "+config.key, "Content-Length":Buffer.byteLength(body) } };
    const transport = options.port===443 ? https : http;
    const req = transport.request(options, function(res) {
      let data = "";
      res.on("data", function(c) { data+=c; });
      res.on("end", function() { try { const j=JSON.parse(data); resolve(j.choices?.[0]?.message?.content||""); } catch(e) { resolve(null); } });
    });
    req.on("error", function() { resolve(null); });
    req.write(body); req.end();
  });
}

async function aiChat(messages) {
  const configs = await getAIConfigs();
  for (let i=0; i<configs.length; i++) {
    const r = await callAI(messages, configs[i]);
    if (r!==null) return r;
  }
  return "AI 服务暂不可用，请稍后再试。";
}

// Auto-match pain points when new content arrives
async function autoMatchPainPoints(text) {
  try {
    const openPPs = await painpointsCol.find({ status: { $ne: "resolved" } }).toArray();
    if (openPPs.length === 0) return;
    const lowerText = (text || "").toLowerCase();
    const matched = [];
    openPPs.forEach(function(pp) {
      const keywords = (pp.keywords || []).concat([pp.title || ""]);
      for (let i = 0; i < keywords.length; i++) {
        if (keywords[i] && lowerText.indexOf(keywords[i].toLowerCase()) >= 0) {
          matched.push(pp);
          break;
        }
      }
    });
    if (matched.length > 0) {
      console.log("[PainMatch] 发现 " + matched.length + " 个相关痛点");
      // Ask AI to check if the new content actually provides solutions
      const ppList = matched.map(function(pp, i) { return (i+1)+". "+pp.title+"（"+pp.description+"）"; }).join("\n");
      const messages = [
        { role:"system", content:"你是痛点匹配助手。用户有以下未解决的痛点：\n"+ppList+"\n\n新内容：\n"+text+"\n\n请判断新内容是否提供了某个痛点的解决方法。如果有的话，返回JSON格式：{\"matches\":[{\"painId\":\"痛点ID\",\"solution\":\"解决方法摘要\"}]}。如果没有匹配，返回{\"matches\":[]}。只返回JSON，不要其他文字。" },
        { role:"user", content:text }
      ];
      const aiResult = await aiChat(messages);
      try {
        const parsed = JSON.parse(aiResult);
        if (parsed.matches && parsed.matches.length > 0) {
          for (const m of parsed.matches) {
            const pp = matched.find(function(p){ return p._id.toString() === m.painId; }) || matched[0];
            await painpointsCol.updateOne(
              { _id: pp._id },
              { $set: { status: "resolved", solution: m.solution, resolvedAt: new Date().toISOString() },
                $push: { history: { action: "auto_resolved", content: m.solution, date: new Date().toISOString() } } }
            );
            console.log("[PainMatch] 痛点已自动解决: " + pp.title);
          }
        }
      } catch(e) { /* AI returned non-JSON, ignore */ }
    }
  } catch(err) {
    console.error("[PainMatch] 匹配失败:", err.message);
  }
}

function serveFile(res, filepath) {
  try { const c=fs.readFileSync(filepath); const ext=path.extname(filepath).slice(1); res.writeHead(200,{"Content-Type":mime[ext]||"text/plain","Cache-Control":"no-cache"}); res.end(c); }
  catch(e) { res.writeHead(404); res.end("404"); }
}

initDB().then(function() {
  http.createServer(async function(req, res) {
  try {
    const url = new URL(req.url, "http://localhost:"+PORT);
    const pathname = url.pathname;
    const method = req.method;
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,OPTIONS,DELETE");
    res.setHeader("Access-Control-Allow-Headers","Content-Type");
    if (method==="OPTIONS") { res.writeHead(200); res.end(); return; }

    // ===== 日记 entries =====
    if (pathname==="/api/entries" && method==="GET") {
      const entries = await entriesCol.find({}).sort({ createdAt:-1 }).toArray();
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(entries));
      return;
    }

    if (pathname==="/api/entries" && method==="DELETE") {
      const body = await parseBody(req);
      if (body.id) {
        await entriesCol.deleteOne({ id: body.id });
        const allEntries = await entriesCol.find({}).toArray();
        await updateStats(allEntries);
      }
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true}));
      return;
    }

    if (pathname==="/api/entries" && method==="PUT") {
      const body = await parseBody(req);
      if (body.id) {
        await entriesCol.updateOne({ id: body.id }, { $set: {
          content: body.content || "",
          blocks: body.blocks || [],
          tags: body.tags || []
        }});
        const updated = await entriesCol.findOne({ id: body.id });
        if (updated) {
          syncDiaryToPks(updated);
          autoMatchPainPoints(updated.content + " " + (updated.blocks||[]).map(function(b){return b.content;}).join(" "));
        }
      }
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true}));
      return;
    }

    if (pathname==="/api/entries" && method==="POST") {
      const body = await parseBody(req);
      const entry = {
        id: crypto.randomUUID(),
        content: body.content || "",
        blocks: body.blocks || [],
        tags: body.tags || [],
        date: body.date || new Date().toISOString().split("T")[0],
        createdAt: new Date().toISOString()
      };
      await entriesCol.insertOne(entry);
      const allEntries = await entriesCol.find({}).toArray();
      await updateStats(allEntries);
      syncDiaryToPks(entry);
      autoMatchPainPoints(entry.content + " " + (entry.blocks||[]).map(function(b){return b.content;}).join(" "));
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(entry));
      return;
    }

    // ===== 统计 =====
    if (pathname==="/api/stats" && method==="GET") {
      const allEntries = await entriesCol.find({}).toArray();
      await updateStats(allEntries);
      const s = await getStats();
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ totalEntries:s.totalEntries, totalWords:s.totalWords, streak:s.streak, lastDate:s.lastDate }));
      return;
    }

    if (pathname==="/api/tags" && method==="GET") {
      const entries = await entriesCol.find({}).toArray();
      const tagCounts = {};
      entries.forEach(function(e) { (e.tags||[]).forEach(function(t) { tagCounts[t]=(tagCounts[t]||0)+1; }); });
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(tagCounts));
      return;
    }

    // ===== AI =====
    if (pathname==="/api/analyze" && method==="POST") {
      const body = await parseBody(req);
      const recent = await entriesCol.find({}).sort({ createdAt:-1 }).limit(50).toArray();
      const context = recent.map(function(e) { return "["+e.date+"] "+(e.content||"")+" "+(e.blocks||[]).map(function(b){return b.type+":"+b.content}).join(" "); }).join("\n");
      const messages = [
        { role:"system", content:"你是一个日记分析助手。根据用户的日记内容，给出简短的观察、发现的行为模式、情绪趋势或建议。用中文回复，控制在200字以内。格式清晰，可以分段。" },
        { role:"user", content:"以下是我的日记内容，请分析：\n"+context+"\n\n用户问题："+(body.question||"请分析我最近的日记模式") }
      ];
      const answer = await aiChat(messages);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ answer }));
      return;
    }

    if (pathname==="/api/summary" && method==="POST") {
      const body = await parseBody(req);
      const range = body.range || "week";
      const now = new Date();
      let fromDate;
      if (range==="week") { fromDate = new Date(now); fromDate.setDate(fromDate.getDate()-7); }
      else if (range==="month") { fromDate = new Date(now); fromDate.setMonth(fromDate.getMonth()-1); }
      else if (range==="all") { fromDate = new Date(0); }
      const fromStr = fromDate.toISOString().split("T")[0];
      const entries = await entriesCol.find({ date: { $gte: fromStr } }).sort({ createdAt:-1 }).toArray();
      const tagStats = {};
      const blockStats = {};
      const dayCount = {};
      entries.forEach(function(e) {
        dayCount[e.date] = (dayCount[e.date]||0)+1;
        (e.tags||[]).forEach(function(t) { tagStats[t]=(tagStats[t]||0)+1; });
        (e.blocks||[]).forEach(function(b) { blockStats[b.type]=(blockStats[b.type]||0)+1; });
      });
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({
        totalEntries: entries.length,
        totalDays: Object.keys(dayCount).length,
        tagStats, blockStats,
        dateRange: entries.length>0 ? { from:fromStr, to:now.toISOString().split("T")[0] } : null
      }));
      return;
    }

    // ===== 痛点 Pain Points =====
    if (pathname==="/api/painpoints" && method==="GET") {
      const pps = await painpointsCol.find({}).sort({ createdAt:-1 }).toArray();
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(pps));
      return;
    }

    if (pathname==="/api/painpoints" && method==="POST") {
      const body = await parseBody(req);
      const pp = {
        id: crypto.randomUUID(),
        title: body.title || "",
        description: body.description || "",
        keywords: body.keywords || [],
        severity: body.severity || "medium",
        status: body.status || "open",
        solution: "",
        source: body.source || "manual",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        history: [{ action:"created", content:body.title, date:new Date().toISOString() }]
      };
      await painpointsCol.insertOne(pp);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(pp));
      return;
    }

    if (pathname==="/api/painpoints" && method==="PUT") {
      const body = await parseBody(req);
      if (body.id) {
        const update = {};
        if (body.title !== undefined) update.title = body.title;
        if (body.description !== undefined) update.description = body.description;
        if (body.keywords !== undefined) update.keywords = body.keywords;
        if (body.severity !== undefined) update.severity = body.severity;
        if (body.status !== undefined) update.status = body.status;
        if (body.solution !== undefined) {
          update.solution = body.solution;
          if (body.solution && body.status !== "resolved") update.status = "resolved";
          if (!update.status || update.status === "resolved") update.resolvedAt = new Date().toISOString();
        }
        await painpointsCol.updateOne({ id: body.id }, { $set: update });
        await painpointsCol.updateOne({ id: body.id }, { $push: { history: { action:"updated", content:JSON.stringify(update), date:new Date().toISOString() } } });
      }
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true}));
      return;
    }

    if (pathname==="/api/painpoints" && method==="DELETE") {
      const body = await parseBody(req);
      if (body.id) {
        await painpointsCol.deleteOne({ id: body.id });
      }
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true}));
      return;
    }

    // ===== 设置 Settings =====
    if (pathname==="/api/settings" && method==="GET") {
      const s = await getSettings();
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(s));
      return;
    }

    if (pathname==="/api/settings" && method==="PUT") {
      const body = await parseBody(req);
      const update = {};
      if (body.theme !== undefined) update.theme = body.theme;
      if (body.apiConfigs !== undefined) update.apiConfigs = body.apiConfigs;
      if (body.autoPainMatch !== undefined) update.autoPainMatch = body.autoPainMatch;
      await settingsCol.updateOne({ _id:"main" }, { $set: update }, { upsert:true });
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true}));
      return;
    }

    // ===== 静态文件 =====
    let filepath = pathname==="/" ? "index.html" : pathname.slice(1);
    filepath = path.join(__dirname, filepath);
    serveFile(res, filepath);
  } catch(err) {
    console.error("[Server] 请求处理错误:", err.message);
    if (!res.headersSent) {
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error: err.message}));
    }
  }
  }).listen(PORT, function() { console.log("日记 app 运行在 http://localhost:"+PORT); });
}).catch(function(err) { console.error("数据库初始化失败:", err.message); process.exit(1); });