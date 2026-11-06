import { tokenizeSql } from "../sql-guard.js";

// System metadata (catalog views, INFORMATION_SCHEMA, msdb) describes the database, not its people:
// it is returned in clear. A few system objects do carry user data in clear (query text with literal
// values, plans with sniffed parameters, Database Mail bodies, job messages, audit and XE files):
// they are never treated as system metadata. Module definitions (sql_modules, ROUTINES) are code and
// stay readable. The value floor (e-mail, IBAN, fiscal code) still applies.
const SYSTEM_SCHEMAS = new Set(["sys", "information_schema"]);
const SYSTEM_DATABASES = new Set(["msdb"]);
const DATA_CARRYING_SYSTEM_OBJECTS = new Set([
  "dm_exec_sql_text",
  "dm_exec_input_buffer",
  "dm_exec_query_plan",
  "dm_exec_text_query_plan",
  "dm_exec_query_statistics_xml",
  "dm_exec_query_plan_stats",
  "query_store_query_text",
  "query_store_plan",
  "sysjobhistory",
  "sysjobstepslogs",
  "sysjobsteps",
  "sysmail_allitems",
  "sysmail_mailitems",
  "sysmail_sentitems",
  "sysmail_unsentitems",
  "sysmail_faileditems",
  "sysmail_mailattachments",
  "sysmail_attachments",
  "sysmail_log",
  "sysmail_event_log",
  "fn_get_audit_file",
  "fn_xe_file_target_read_file",
  "dm_xe_session_targets"
]);

const FROM_LIST_END = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT", "OPTION", "FOR", "WINDOW", "SELECT"
]);

function partValue(token) {
  return String(token.value).toLowerCase();
}

// A multi-part name (db.schema.object, schema.object, db..object) as lower-case parts, or null.
function readObjectName(tokens, start) {
  const parts = [];
  let index = start;
  let expectName = true;
  while (index < tokens.length) {
    const token = tokens[index];
    if (expectName && (token.type === "word" || token.type === "quoted")) {
      parts.push(partValue(token));
      expectName = false;
      index += 1;
      continue;
    }
    if (token.type === "punct" && token.value === ".") {
      if (expectName) parts.push("");
      expectName = true;
      index += 1;
      continue;
    }
    break;
  }
  return parts.length > 0 && !expectName ? { parts, end: index } : null;
}

function classifyObject(parts) {
  const object = parts[parts.length - 1];
  if (DATA_CARRYING_SYSTEM_OBJECTS.has(object)) return false;
  if (parts.length >= 2 && SYSTEM_SCHEMAS.has(parts[parts.length - 2])) return true;
  if (parts.length >= 3 && SYSTEM_DATABASES.has(parts[parts.length - 3])) return true;
  return false;
}

/**
 * True only when every object the query reads is system metadata. Conservative by design: unknown
 * syntax, bare names (user tables, CTEs, temp tables, variables), and any non-system multi-part
 * function call make it false, so the query falls back to normal anonymization.
 */
export function isSystemMetadataQuery(sqlText) {
  let tokens;
  try {
    tokens = tokenizeSql(String(sqlText || ""));
  } catch {
    return false;
  }
  let depth = 0;
  const inFromList = new Map();
  let references = 0;

  const checkReference = index => {
    const token = tokens[index];
    if (!token) return false;
    if (token.type === "punct" && token.value === "(") return true; // derived table: its own FROM is scanned
    const name = readObjectName(tokens, index);
    if (!name) return false;
    references += 1;
    return classifyObject(name.parts);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "punct" && token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.type === "punct" && token.value === ")") {
      inFromList.delete(depth);
      depth -= 1;
      continue;
    }
    if (token.type === "word") {
      const upper = token.upper;
      if (upper === "FROM" || upper === "JOIN" || upper === "APPLY") {
        if (upper === "FROM") inFromList.set(depth, true);
        if (!checkReference(index + 1)) return false;
        continue;
      }
      if (FROM_LIST_END.has(upper)) {
        inFromList.set(depth, false);
        continue;
      }
      // Any multi-part function call (dbo.fn(...), other_db.dbo.fn(...)) can read user tables.
      const name = readObjectName(tokens, index);
      if (name && name.parts.length >= 2 && tokens[name.end]?.type === "punct" && tokens[name.end].value === "(") {
        if (!classifyObject(name.parts)) return false;
        index = name.end - 1;
        continue;
      }
      continue;
    }
    if (token.type === "punct" && token.value === "," && inFromList.get(depth)) {
      if (!checkReference(index + 1)) return false;
    }
  }
  return references > 0;
}

/** True when a resolved column origin points at system metadata (never a data-carrying object). */
export function isSystemOrigin(origin) {
  if (!origin) return false;
  const database = String(origin.database ?? "").toLowerCase();
  const schema = String(origin.schema ?? "").toLowerCase();
  const table = String(origin.table ?? "").toLowerCase();
  if (DATA_CARRYING_SYSTEM_OBJECTS.has(table)) return false;
  return SYSTEM_SCHEMAS.has(schema) || SYSTEM_DATABASES.has(database);
}
