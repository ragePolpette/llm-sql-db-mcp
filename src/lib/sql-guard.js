// Statements that never belong to a single read-only or single DML statement. Matching is done
// on unquoted word tokens only, so string literals, comments and quoted identifiers never match.
const NON_DML_STATEMENT_KEYWORDS = [
  "DROP",
  "ALTER",
  "TRUNCATE",
  "CREATE",
  "EXEC",
  "EXECUTE",
  "ADD",
  "BACKUP",
  "BEGIN",
  "BULK",
  "CHECKPOINT",
  "COMMIT",
  "CONVERSATION",
  "DBCC",
  "DECLARE",
  "DENY",
  "DISABLE",
  "ENABLE",
  "GOTO",
  "GRANT",
  "IF",
  "KILL",
  "OPENDATASOURCE",
  "OPENQUERY",
  "OPENROWSET",
  "PRINT",
  "RAISERROR",
  "READTEXT",
  "RECEIVE",
  "RECONFIGURE",
  "RESTORE",
  "RETURN",
  "REVERT",
  "REVOKE",
  "ROLLBACK",
  "SAVE",
  "SEND",
  "SETUSER",
  "SHUTDOWN",
  "THROW",
  "UPDATETEXT",
  "USE",
  "WAITFOR",
  "WHILE",
  "WRITETEXT"
];

const READ_FORBIDDEN_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "INTO",
  "SET",
  ...NON_DML_STATEMENT_KEYWORDS
]);

const WRITE_FORBIDDEN_KEYWORDS = new Set(NON_DML_STATEMENT_KEYWORDS);
const WRITE_STATEMENT_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const SET_OPERATOR_KEYWORDS = new Set(["UNION", "ALL", "EXCEPT", "INTERSECT"]);

const WORD_CHAR = /[\p{L}\p{N}_@#$]/u;
const WHITESPACE = /\s/u;

class SqlGuardError extends Error {}

function readDelimited(sql, start, closer, label) {
  let index = start + 1;
  let value = "";
  while (index < sql.length) {
    const char = sql[index];
    if (char === closer) {
      if (sql[index + 1] === closer) {
        value += closer;
        index += 2;
        continue;
      }
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  throw new SqlGuardError(`Unterminated ${label}.`);
}

/**
 * Single-pass T-SQL tokenizer. Comments are dropped; string literals and quoted identifiers are
 * kept as opaque tokens so that nothing inside them can influence the statement analysis.
 * Token types: word, string, quoted, punct.
 */
export function tokenizeSql(sql) {
  const tokens = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (WHITESPACE.test(char)) {
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (depth > 0) {
        if (index >= sql.length) {
          throw new SqlGuardError("Unterminated block comment.");
        }
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if ((char === "N" || char === "n") && next === "'") {
      const { value, end } = readDelimited(sql, index + 1, "'", "string literal");
      tokens.push({ type: "string", value });
      index = end;
      continue;
    }

    if (char === "'") {
      const { value, end } = readDelimited(sql, index, "'", "string literal");
      tokens.push({ type: "string", value });
      index = end;
      continue;
    }

    if (char === "[") {
      const { value, end } = readDelimited(sql, index, "]", "bracketed identifier");
      tokens.push({ type: "quoted", value });
      index = end;
      continue;
    }

    if (char === "\"") {
      const { value, end } = readDelimited(sql, index, "\"", "quoted identifier");
      tokens.push({ type: "quoted", value });
      index = end;
      continue;
    }

    if (WORD_CHAR.test(char)) {
      let end = index + 1;
      while (end < sql.length && WORD_CHAR.test(sql[end])) {
        end += 1;
      }
      const value = sql.slice(index, end);
      tokens.push({ type: "word", value, upper: value.toUpperCase() });
      index = end;
      continue;
    }

    tokens.push({ type: "punct", value: char });
    index += 1;
  }

  return tokens;
}

function isWord(token, upper) {
  return token?.type === "word" && token.upper === upper;
}

function isPunct(token, value) {
  return token?.type === "punct" && token.value === value;
}

function renderMaskedSql(tokens) {
  return tokens
    .map(token => {
      if (token.type === "string") return "''";
      if (token.type === "quoted") return "[]";
      return token.value;
    })
    .join(" ");
}

function stripStatementTerminators(tokens) {
  let start = 0;
  while (start < tokens.length && isPunct(tokens[start], ";")) {
    start += 1;
  }

  let end = tokens.length;
  while (end > start && isPunct(tokens[end - 1], ";")) {
    end -= 1;
  }

  const body = tokens.slice(start, end);
  if (body.some(token => isPunct(token, ";"))) {
    throw new SqlGuardError("Multiple SQL statements are not allowed.");
  }
  return body;
}

function computeDepths(tokens) {
  const depths = [];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, ")")) {
      depth -= 1;
      if (depth < 0) {
        throw new SqlGuardError("Unbalanced parentheses in SQL text.");
      }
    }
    depths.push(depth);
    if (isPunct(token, "(")) {
      depth += 1;
    }
  }
  if (depth !== 0) {
    throw new SqlGuardError("Unbalanced parentheses in SQL text.");
  }
  return depths;
}

function skipParenthesized(tokens, depths, openIndex) {
  const baseDepth = depths[openIndex];
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    if (isPunct(tokens[index], ")") && depths[index] === baseDepth) {
      return index + 1;
    }
  }
  throw new SqlGuardError("Unbalanced parentheses in SQL text.");
}

// Returns the index of the statement keyword that follows a `WITH` common table expression list.
function skipCtePrefix(tokens, depths) {
  if (!isWord(tokens[0], "WITH")) {
    return 0;
  }

  let index = 1;
  for (;;) {
    const name = tokens[index];
    if (name?.type !== "word" && name?.type !== "quoted") {
      throw new SqlGuardError("Malformed common table expression.");
    }
    index += 1;

    if (name.type === "word" && name.upper === "XMLNAMESPACES") {
      if (!isPunct(tokens[index], "(")) {
        throw new SqlGuardError("Malformed common table expression.");
      }
      index = skipParenthesized(tokens, depths, index);
    } else {
      if (isPunct(tokens[index], "(")) {
        index = skipParenthesized(tokens, depths, index);
      }
      if (!isWord(tokens[index], "AS") || !isPunct(tokens[index + 1], "(")) {
        throw new SqlGuardError("Malformed common table expression.");
      }
      index = skipParenthesized(tokens, depths, index + 1);
    }

    if (isPunct(tokens[index], ",")) {
      index += 1;
      continue;
    }
    return index;
  }
}

function assertNoBatchSeparator(tokens) {
  if (tokens.some(token => isWord(token, "GO"))) {
    throw new SqlGuardError("Batch separator GO is not allowed.");
  }
}

// `USE` is a reserved word, so right after `(` or `,` it can only be a query hint such as
// OPTION (USE HINT ('...')) or OPTION (MAXDOP 1, USE PLAN N'...'), never a USE statement.
function isQueryHintUse(tokens, index) {
  const previous = tokens[index - 1];
  return tokens[index].upper === "USE" && (isPunct(previous, "(") || isPunct(previous, ","));
}

function assertNoForbiddenKeyword(tokens, forbidden) {
  tokens.forEach((token, index) => {
    if (token.type === "word" && forbidden.has(token.upper) && !isQueryHintUse(tokens, index)) {
      throw new SqlGuardError(`Forbidden SQL keyword detected: ${token.upper}.`);
    }
  });
}

function multipleStatements() {
  return new SqlGuardError("Multiple SQL statements are not allowed.");
}

function assertSingleReadStatement(tokens, depths, mainIndex) {
  for (let index = mainIndex + 1; index < tokens.length; index += 1) {
    if (depths[index] !== 0 || !isWord(tokens[index], "SELECT")) continue;
    const previous = tokens[index - 1];
    if (!(previous?.type === "word" && SET_OPERATOR_KEYWORDS.has(previous.upper))) {
      throw multipleStatements();
    }
  }
}

function assertSingleWriteStatement(tokens, depths, mainIndex) {
  const main = tokens[mainIndex].upper;
  let selectSeen = false;
  let valuesSeen = false;
  let setCount = 0;
  let outputOpen = false;

  for (let index = mainIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token.type !== "word") continue;

    if (token.upper === "INTO") {
      const directTarget = isWord(previous, "INSERT") || isWord(previous, "MERGE");
      if (!directTarget && !outputOpen) {
        throw new SqlGuardError("SELECT INTO is not allowed.");
      }
      continue;
    }

    if (depths[index] !== 0) continue;

    if (token.upper === "OUTPUT") {
      outputOpen = true;
      continue;
    }

    if (WRITE_STATEMENT_KEYWORDS.has(token.upper)) {
      if (!(main === "MERGE" && isWord(previous, "THEN"))) {
        throw multipleStatements();
      }
      continue;
    }

    if (token.upper === "VALUES") {
      valuesSeen = true;
      continue;
    }

    if (token.upper === "SET") {
      setCount += 1;
      const allowed =
        (main === "UPDATE" && setCount === 1) ||
        (main === "MERGE" && isWord(previous, "UPDATE"));
      if (!allowed) {
        throw multipleStatements();
      }
      continue;
    }

    if (token.upper === "SELECT") {
      outputOpen = false;
      const afterSetOperator = previous?.type === "word" && SET_OPERATOR_KEYWORDS.has(previous.upper);
      const insertSource = main === "INSERT" && !selectSeen && !valuesSeen;
      if (!afterSetOperator && !insertSource) {
        throw multipleStatements();
      }
      selectSeen = true;
    }
  }

  if (main === "UPDATE" && setCount !== 1) {
    throw new SqlGuardError("UPDATE statements must have exactly one SET clause.");
  }
}

function analyzeSql(sql, mode) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new SqlGuardError("SQL text is required.");
  }

  const tokens = stripStatementTerminators(tokenizeSql(sql));
  if (tokens.length === 0) {
    throw new SqlGuardError("SQL text is required.");
  }

  const first = tokens[0];
  if (mode === "read") {
    if (!(isWord(first, "SELECT") || isWord(first, "WITH"))) {
      throw new SqlGuardError("Only SELECT statements or read-only CTEs are allowed.");
    }
  } else if (!(first.type === "word" && (WRITE_STATEMENT_KEYWORDS.has(first.upper) || first.upper === "WITH"))) {
    throw new SqlGuardError("Only INSERT, UPDATE, DELETE, MERGE, or write CTE statements are allowed.");
  }

  assertNoBatchSeparator(tokens);
  assertNoForbiddenKeyword(tokens, mode === "read" ? READ_FORBIDDEN_KEYWORDS : WRITE_FORBIDDEN_KEYWORDS);

  const depths = computeDepths(tokens);
  const mainIndex = skipCtePrefix(tokens, depths);
  const main = tokens[mainIndex];

  if (mode === "read") {
    if (!isWord(main, "SELECT")) {
      throw new SqlGuardError("Only read-only CTEs that resolve to SELECT are allowed.");
    }
    assertSingleReadStatement(tokens, depths, mainIndex);
  } else {
    if (!(main?.type === "word" && WRITE_STATEMENT_KEYWORDS.has(main.upper))) {
      throw new SqlGuardError("Write CTEs must resolve to INSERT, UPDATE, DELETE, or MERGE.");
    }
    assertSingleWriteStatement(tokens, depths, mainIndex);
  }

  return renderMaskedSql(tokens);
}

function inspect(sql, mode) {
  try {
    return {
      allowed: true,
      reason: null,
      normalizedSql: analyzeSql(sql, mode)
    };
  } catch (error) {
    if (!(error instanceof SqlGuardError)) {
      throw error;
    }
    return {
      allowed: false,
      reason: error.message
    };
  }
}

export function inspectSqlSafety(sql) {
  return inspect(sql, "read");
}

export function inspectWriteSafety(sql) {
  return inspect(sql, "write");
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
