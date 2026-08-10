import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/dataDir";
import { DATA_DIR, DATA_FILE } from "@/lib/db/paths";
import { poolFitnessSnapshot } from "open-sse/services/proxyPoolFitness.js";
import { poolGeoSnapshot } from "open-sse/services/poolGeo.js";

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function dirSizeMB(dir, maxDepth = 4) {
  let total = 0;
  const walk = (p, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch { /* skip */ }
    }
  };
  walk(dir, 0);
  return total;
}

// GET /api/system/memory — data + in-memory state sizes.
export async function GET() {
  try {
    const dataDir = getDataDir();
    const dbPath = DATA_FILE;
    let dbFile = 0;
    try { dbFile = fs.statSync(dbPath).size; } catch { dbFile = 0; }

    const fitness = poolFitnessSnapshot();
    const geo = poolGeoSnapshot();
    const { sessionStateSize } = await import("open-sse/executors/freebuff.js");

    return NextResponse.json({
      dataDir,
      dbPath,
      dbSizeMB: formatMB(dbFile),
      dataDirSizeMB: formatMB(dirSizeMB(dataDir)),
      inMemory: {
        fitnessPools: Object.keys(fitness).length,
        geoPools: Object.keys(geo).length,
        freebuff: sessionStateSize(),
      },
    });
  } catch (error) {
    console.log("Error reading memory sizes:", error);
    return NextResponse.json({ error: "Failed to read memory sizes" }, { status: 500 });
  }
}