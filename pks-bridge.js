/**
 * PKS Bridge - syncs diary entries to the knowledge-base.
 * Called automatically on POST/PUT in server.js.
 */
const fs = require("fs");
const path = require("path");

const KB_DIR = path.resolve(__dirname, "..", "knowledge-base");
const DOMAIN_DIR = path.join(KB_DIR, "domain");
const INDEX_PATH = path.join(KB_DIR, "index.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function syncDiaryToPks(entry) {
  try {
    if (!entry || !entry.content) return;

    const diaryDir = path.join(DOMAIN_DIR, "\u65e5\u8bb0");
    ensureDir(diaryDir);

    const today = entry.date || new Date().toISOString().split("T")[0];
    const safeName = today.replace(/[\\/:*?"<>|]/g, "_") + ".md";
    const filePath = path.join(diaryDir, safeName);

    // Build block summary
    let blockText = "";
    if (entry.blocks && entry.blocks.length > 0) {
      entry.blocks.forEach(function (b) {
        if (b.content && b.content.trim()) {
          blockText += "- " + (b.label || b.type) + ": " + b.content.trim() + "\n";
        }
      });
    }

    // Build tag list
    const tags = (entry.tags || []).join(",");

    // Write front matter + content
    const lines = [
      "---",
      "created: " + today,
      "updated: " + today,
      "domain: \u65e5\u8bb0",
      "title: " + today,
      "tags: [" + tags + "]",
      "version: 1",
      "mastery: 0.3",
      'next_action: ""',
      "cross_domain: []",
      "---",
      "",
      "# " + today,
      "",
    ];

    if (entry.content && entry.content.trim()) {
      lines.push("## \u5185\u5bb9");
      lines.push(entry.content.trim());
      lines.push("");
    }

    if (blockText) {
      lines.push("## \u683c\u5b50");
      lines.push(blockText);
    }

    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
    console.log("[PKS] \u65e5\u8bb0\u5df2\u540c\u6b65: " + today);

    // Rebuild index
    rebuildIndex();
  } catch (err) {
    console.error("[PKS] \u540c\u6b65\u5931\u8d25:", err.message);
  }
}

function rebuildIndex() {
  try {
    if (!fs.existsSync(DOMAIN_DIR)) return;

    const entries = [];
    const domains = fs.readdirSync(DOMAIN_DIR).filter(function (d) {
      return fs.statSync(path.join(DOMAIN_DIR, d)).isDirectory();
    });

    domains.forEach(function (dname) {
      const dd = path.join(DOMAIN_DIR, dname);
      const files = fs.readdirSync(dd).filter(function (f) {
        return f.endsWith(".md") && f !== "_domain.yaml";
      });

      files.forEach(function (fname) {
        const fp = path.join(dd, fname);
        const content = fs.readFileSync(fp, "utf-8");
        const fm = parseFrontMatter(content);

        const tagsRaw = (fm.tags || "[]").replace(/[\[\]]/g, "");
        const tags = tagsRaw
          .split(",")
          .map(function (t) { return t.trim().replace(/"/g, ""); })
          .filter(Boolean);

        entries.push({
          file: fname,
          domain: dname,
          title: fm.title || fname.replace(".md", ""),
          created: fm.created || "",
          updated: fm.updated || "",
          tags: tags,
          mastery: parseFloat(fm.mastery) || 0.5,
          version: parseInt(fm.version) || 1,
          next_action: (fm.next_action || "").replace(/"/g, ""),
          cross_domain_raw: fm.cross_domain || "[]",
        });
      });
    });

    // Build domain summary
    const domainSummary = {};
    entries.forEach(function (e) {
      if (!domainSummary[e.domain]) {
        domainSummary[e.domain] = { count: 0, totalMastery: 0 };
      }
      domainSummary[e.domain].count++;
      domainSummary[e.domain].totalMastery += e.mastery;
    });

    const domainsOut = {};
    Object.keys(domainSummary).forEach(function (d) {
      const info = domainSummary[d];
      domainsOut[d] = {
        name: d,
        count: info.count,
        avgMastery: Math.round((info.totalMastery / info.count) * 100) / 100,
        stage: "",
        bottleneck: "",
      };
    });

    const index = {
      updated: new Date().toISOString(),
      totalEntries: entries.length,
      domains: domainsOut,
      entries: entries,
    };

    ensureDir(KB_DIR);
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
    console.log("[PKS] \u7d22\u5f15\u5df2\u66f4\u65b0: " + entries.length + " \u6761, " + Object.keys(domainsOut).length + " \u4e2a\u9886\u57df");

    // Build graph
    buildGraph(entries);
  } catch (err) {
    console.error("[PKS] \u7d22\u5f15\u66f4\u65b0\u5931\u8d25:", err.message);
  }
}

function parseFrontMatter(content) {
  const fm = {};
  if (!content.startsWith("---")) return fm;
  const endIdx = content.indexOf("---", 3);
  if (endIdx < 0) return fm;
  const block = content.substring(3, endIdx).trim();
  block.split("\n").forEach(function (line) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fm[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    }
  });
  return fm;
}

function buildGraph(entries) {
  const nodes = entries.map(function (e) {
    return {
      id: e.domain + "/" + e.file,
      domain: e.domain,
      title: e.title,
      mastery: e.mastery,
      tags: e.tags,
    };
  });

  // Auto-discover cross-domain edges by shared tags
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].domain === nodes[j].domain) continue;
      const overlap = nodes[i].tags.filter(function (t) {
        return nodes[j].tags.includes(t);
      });
      if (overlap.length > 0) {
        edges.push({
          from: nodes[i].id,
          to: nodes[j].id,
          relation: "tags\u5173\u8054",
          note: "\u5171\u540c\u6807\u7b7e: " + overlap.join(","),
        });
      }
    }
  }

  const graph = { nodes: nodes, edges: edges };
  const graphPath = path.join(KB_DIR, "\u77e5\u8bc6\u56fe\u8c31.json");
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf-8");
  console.log("[PKS] \u56fe\u8c31\u5df2\u66f4\u65b0: " + nodes.length + " \u8282\u70b9, " + edges.length + " \u8fb9");
}

module.exports = { syncDiaryToPks: syncDiaryToPks };