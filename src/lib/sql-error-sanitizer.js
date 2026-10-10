// SQL Server error messages can echo data values, e.g.
//   245   Conversion failed when converting the nvarchar value 'Rossi' to data type int.
//   13609 JSON text is not properly formatted. Unexpected character 'R' is found at position 0.
// On targets with anonymization this turns `CAST(cognome AS int)` into a way to read values in clear.
//
// Rule: errors raised while *compiling* the query happen before any row is read, so their text can
// only contain what the caller wrote (identifiers, syntax). Those are kept verbatim, which keeps them
// useful for fixing the query. Every other SQL error, including unknown numbers and driver errors
// without a number, is redacted: quoted fragments and "value is (...)" tuples are removed.
// Errors that do not come from SQL Server at all (our own policy/runtime messages) are not touched.

const COMPILE_TIME_ERROR_NUMBERS = new Set([
  102, // Incorrect syntax near '%.*ls'.
  105, // Unclosed quotation mark after the character string '%.*ls'.
  116, // Only one expression can be specified in the select list when the subquery is not introduced with EXISTS.
  130, // Cannot perform an aggregate function on an expression containing an aggregate or a subquery.
  137, // Must declare the scalar variable "%.*ls".
  144, // Cannot use an aggregate or a subquery in an expression used for the group by list.
  145, // ORDER BY items must appear in the select list if SELECT DISTINCT is specified.
  147, // An aggregate may not appear in the WHERE clause...
  156, // Incorrect syntax near the keyword '%.*ls'.
  174, // The %.*ls function requires %d argument(s).
  189, // The %.*ls function requires %d to %d arguments.
  195, // '%.*ls' is not a recognized built-in function name.
  206, // Operand type clash: %ls is incompatible with %ls
  207, // Invalid column name '%.*ls'.
  208, // Invalid object name '%.*ls'.
  209, // Ambiguous column name '%.*ls'.
  306, // The text, ntext, and image data types cannot be compared or sorted...
  402, // The data types %s and %s are incompatible in the %s operator.
  1013, // The objects ... in the FROM clause have the same exposed names.
  1038, // An object or column name is missing or empty.
  4104, // The multi-part identifier "%.*ls" could not be bound.
  4108, // Windowed functions can only appear in the SELECT or ORDER BY clauses.
  4109, // Windowed functions cannot be used in the context of another windowed function or aggregate.
  4121, // Cannot find either column "%.*ls" or the user-defined function or aggregate "%.*ls"...
  4145, // An expression of non-boolean type specified in a context where a condition is expected, near '%.*ls'.
  8116, // Argument data type %ls is invalid for argument %d of %ls function.
  8117, // Operand data type %ls is invalid for %ls operator.
  8120, // Column '%.*ls' is invalid in the select list because it is not contained in ... GROUP BY clause.
  8127, // Column "%.*ls" is invalid in the ORDER BY clause because it is not contained in ...
  8155, // No column name was specified for column %d of '%.*ls'.
  8156 // The column '%.*ls' was specified multiple times for '%.*ls'.
]);

const REDACTED = "<redacted>";
const REDACTION_NOTE = " [values redacted: this target uses anonymization]";

function sqlErrorNumbers(error) {
  const errors = [error, ...(Array.isArray(error?.precedingErrors) ? error.precedingErrors : [])];
  return errors.map(entry => entry?.number);
}

export function isSqlServerError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.name === "RequestError") return true;
  return Number.isInteger(error.number) && error.number > 0;
}

export function isCompileTimeSqlError(error) {
  const numbers = sqlErrorNumbers(error);
  return numbers.length > 0 && numbers.every(number => COMPILE_TIME_ERROR_NUMBERS.has(number));
}

export function redactSqlErrorText(message) {
  return String(message ?? "")
    .replace(/N?'(?:[^']|'')*'/g, `'${REDACTED}'`)
    .replace(/"(?:[^"\\]|\\.)*"/g, `"${REDACTED}"`)
    .replace(/(value is\s*)\([^)]*\)/gi, `$1(${REDACTED})`);
}

/**
 * Returns the message to show (and log) for a failed read on an anonymized target.
 */
export function sanitizeSqlErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : String(error ?? "");
  if (!isSqlServerError(error) || isCompileTimeSqlError(error)) {
    return { message, redacted: false };
  }
  const redactedMessage = redactSqlErrorText(message);
  return {
    message: redactedMessage === message ? message : `${redactedMessage}${REDACTION_NOTE}`,
    redacted: redactedMessage !== message
  };
}

export const __sqlErrorSanitizerTestUtils = {
  COMPILE_TIME_ERROR_NUMBERS
};
