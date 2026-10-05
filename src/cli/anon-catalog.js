#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  HUMAN_VERDICTS,
  loadCatalogFile,
  normalizeCatalogKey,
  saveCatalogFile
} from "../lib/anonymization/catalog.js";

const KINDS = new Set(["email", "phone", "name", "org", "address", "city", "text", "date", "iban"]);

const USAGE = `Usage: anon-catalog <command> [options]

Commands:
  list [--target <id>] [--status pending|auto-safe|auto-sensitive|all] [--limit <n>]
      Machine observations, most used first (default status: pending).
  human
      Human verdicts shared by every target.
  set <schema.table.column> safe|sensitive [--kind <kind>] [--note <text>]
      Record a human verdict (sensitive requires --kind).
  unset <schema.table.column>
      Remove a human verdict.

Options:
  --file <path>   Catalog file (default: ANON_CATALOG_PATH)
`;

function formatRow(cells, widths) {
  return cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
}

function printTable(stdout, header, rows) {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map(row => String(row[index] ?? "").length))
  );
  stdout.write(`${formatRow(header, widths)}\n`);
  for (const row of rows) stdout.write(`${formatRow(row, widths)}\n`);
}

export function runCli(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: "string" },
        target: { type: "string" },
        status: { type: "string" },
        limit: { type: "string" },
        kind: { type: "string" },
        note: { type: "string" },
        help: { type: "boolean", short: "h" }
      }
    });
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    stdout.write(USAGE);
    return command || values.help ? 0 : 2;
  }

  const filePath = values.file || env.ANON_CATALOG_PATH;
  if (!filePath) {
    stderr.write("No catalog file: pass --file or set ANON_CATALOG_PATH.\n");
    return 2;
  }

  const catalog = loadCatalogFile(filePath);

  if (command === "list") {
    const status = values.status ?? "pending";
    const limit = values.limit ? Number.parseInt(values.limit, 10) : 50;
    const targetIds = values.target ? [values.target] : Object.keys(catalog.targets);
    const rows = [];
    for (const targetId of targetIds) {
      for (const [key, entry] of Object.entries(catalog.targets[targetId] ?? {})) {
        if (status !== "all" && entry.status !== status) continue;
        const reviewed = catalog.human[key] ? `human:${catalog.human[key].verdict}` : "";
        rows.push([targetId, key, entry.status, entry.reason ?? "", entry.kind ?? "", entry.uses ?? 0, entry.cells ?? 0, entry.distinct?.length ?? 0, entry.last_seen ?? "", reviewed]);
      }
    }
    rows.sort((a, b) => b[5] - a[5]);
    printTable(stdout, ["target", "column", "status", "reason", "kind", "uses", "cells", "distinct", "last_seen", "reviewed"], rows.slice(0, limit));
    if (rows.length > limit) stdout.write(`... ${rows.length - limit} more (use --limit)\n`);
    return 0;
  }

  if (command === "human") {
    printTable(
      stdout,
      ["column", "verdict", "kind", "updated_at", "note"],
      Object.entries(catalog.human).map(([key, entry]) => [key, entry.verdict, entry.kind ?? "", entry.updated_at ?? "", entry.note ?? ""])
    );
    return 0;
  }

  if (command === "set") {
    const [rawKey, verdict] = rest;
    const key = normalizeCatalogKey(rawKey);
    if (!key || !HUMAN_VERDICTS.has(verdict)) {
      stderr.write(`set needs <column> and a verdict (safe|sensitive).\n${USAGE}`);
      return 2;
    }
    if (verdict === "sensitive" && !KINDS.has(values.kind)) {
      stderr.write(`sensitive requires --kind (${[...KINDS].join("|")}).\n`);
      return 2;
    }
    catalog.human[key] = {
      verdict,
      ...(verdict === "sensitive" ? { kind: values.kind } : {}),
      ...(values.note ? { note: values.note } : {}),
      updated_at: new Date().toISOString()
    };
    saveCatalogFile(filePath, catalog);
    stdout.write(`${key}: ${verdict}${verdict === "sensitive" ? ` (${values.kind})` : ""}\n`);
    return 0;
  }

  if (command === "unset") {
    const key = normalizeCatalogKey(rest[0]);
    if (!key || !catalog.human[key]) {
      stderr.write(`No human verdict for "${rest[0] ?? ""}".\n`);
      return 1;
    }
    delete catalog.human[key];
    saveCatalogFile(filePath, catalog);
    stdout.write(`${key}: removed\n`);
    return 0;
  }

  stderr.write(`Unknown command: ${command}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
