const READ_FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "EXEC",
  "EXECUTE",
  "INTO"
];

const WRITE_FORBIDDEN_KEYWORDS = [
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "EXEC",
  "EXECUTE"
];

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

function stripStringLiterals(sql) {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

function normalizeSql(sql) {
  return stripStringLiterals(stripComments(sql))
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingStatementTerminator(sql) {
  return sql.replace(/^;\s*/, "");
}

export function inspectSqlSafety(sql) {
  if (typeof sql !== "string" || sql.trim() === "") {
    return {
      allowed: false,
      reason: "SQL text is required."
    };
  }

  const normalized = normalizeSql(sql);
  const inspectionSql = stripLeadingStatementTerminator(normalized);
  const normalizedUpper = inspectionSql.toUpperCase();

  if (!/^(SELECT|WITH)\b/.test(normalizedUpper)) {
    return {
      allowed: false,
      reason: "Only SELECT statements or read-only CTEs are allowed."
    };
  }

  const semicolonCount = (normalizedUpper.match(/;/g) ?? []).length;
  if (semicolonCount > 1 || (semicolonCount === 1 && !normalizedUpper.endsWith(";"))) {
    return {
      allowed: false,
      reason: "Multiple SQL statements are not allowed."
    };
  }

  for (const keyword of READ_FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(normalizedUpper)) {
      return {
        allowed: false,
        reason: `Forbidden SQL keyword detected: ${keyword}.`
      };
    }
  }

  if (normalizedUpper.startsWith("WITH") && !/\bSELECT\b/.test(normalizedUpper)) {
    return {
      allowed: false,
      reason: "Only read-only CTEs that resolve to SELECT are allowed."
    };
  }

  return {
    allowed: true,
    reason: null,
    normalizedSql: inspectionSql
  };
}

export function inspectWriteSafety(sql) {
  if (typeof sql !== "string" || sql.trim() === "") {
    return {
      allowed: false,
      reason: "SQL text is required."
    };
  }

  const normalized = normalizeSql(sql);
  const inspectionSql = stripLeadingStatementTerminator(normalized);
  const normalizedUpper = inspectionSql.toUpperCase();

  if (!/^(INSERT|UPDATE|DELETE|MERGE|WITH)\b/.test(normalizedUpper)) {
    return {
      allowed: false,
      reason: "Only INSERT, UPDATE, DELETE, MERGE, or write CTE statements are allowed."
    };
  }

  const semicolonCount = (normalizedUpper.match(/;/g) ?? []).length;
  if (semicolonCount > 1 || (semicolonCount === 1 && !normalizedUpper.endsWith(";"))) {
    return {
      allowed: false,
      reason: "Multiple SQL statements are not allowed."
    };
  }

  for (const keyword of WRITE_FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(normalizedUpper)) {
      return {
        allowed: false,
        reason: `Forbidden SQL keyword detected: ${keyword}.`
      };
    }
  }

  if (/\bSELECT\s+INTO\b/i.test(normalizedUpper)) {
    return {
      allowed: false,
      reason: "SELECT INTO is not allowed."
    };
  }

  if (normalizedUpper.startsWith("WITH") && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(normalizedUpper)) {
    return {
      allowed: false,
      reason: "Write CTEs must resolve to INSERT, UPDATE, DELETE, or MERGE."
    };
  }

  return {
    allowed: true,
    reason: null,
    normalizedSql: inspectionSql
  };
}

export function assertReadSafeSql(sql) {
  const inspection = inspectSqlSafety(sql);
  if (!inspection.allowed) {
    throw new Error(inspection.reason);
  }

  return String(sql).trim();
}

export function assertWriteSafeSql(sql) {
  const inspection = inspectWriteSafety(sql);
  if (!inspection.allowed) {
    throw new Error(inspection.reason);
  }

  return String(sql).trim();
}
