import test from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";
import {
  isCompileTimeSqlError,
  redactSqlErrorText,
  sanitizeSqlErrorMessage
} from "../src/lib/sql-error-sanitizer.js";

function sqlError(number, message, precedingErrors) {
  const error = new sql.RequestError(message, "EREQUEST");
  error.number = number;
  if (precedingErrors) error.precedingErrors = precedingErrors;
  return error;
}

test("runtime conversion errors lose the data value they echo", () => {
  const { message, redacted } = sanitizeSqlErrorMessage(
    sqlError(245, "Conversion failed when converting the nvarchar value 'Rossi' to data type int.")
  );
  assert.equal(redacted, true);
  assert.equal(message.includes("Rossi"), false);
  assert.match(message, /converting the nvarchar value '<redacted>' to data type int\./);
  assert.match(message, /values redacted/);
});

test("JSON, overflow and duplicate-key style messages are redacted too", () => {
  const json = sanitizeSqlErrorMessage(
    sqlError(13609, "JSON text is not properly formatted. Unexpected character 'R' is found at position 0.")
  );
  assert.equal(json.message.includes("'R'"), false);

  const overflow = sanitizeSqlErrorMessage(
    sqlError(248, "The conversion of the nvarchar value '3331234567' overflowed an int column.")
  );
  assert.equal(overflow.message.includes("3331234567"), false);

  const tuple = sanitizeSqlErrorMessage(sqlError(2627, "Cannot insert duplicate key. The duplicate key value is (mario@x.it)."));
  assert.equal(tuple.message.includes("mario@x.it"), false);
});

test("quoted literals with escaped quotes and N prefixes are fully removed", () => {
  assert.equal(redactSqlErrorText("value N'D''Angelo' here"), "value '<redacted>' here");
  assert.equal(redactSqlErrorText('token "Rossi Mario" is not valid'), 'token "<redacted>" is not valid');
});

test("driver errors without a SQL number are redacted (fail closed)", () => {
  const error = new sql.RequestError(new Error('Failed to parse incoming JSON. Unexpected token \'R\', "Rossi" is not valid JSON'), "EJSON");
  const { message } = sanitizeSqlErrorMessage(error);
  assert.equal(message.includes("Rossi"), false);
});

test("compile-time errors are kept verbatim: they happen before any row is read", () => {
  const original = "Invalid column name 'cognmoe'.";
  assert.deepEqual(sanitizeSqlErrorMessage(sqlError(207, original)), { message: original, redacted: false });
  assert.equal(
    sanitizeSqlErrorMessage(sqlError(102, "Incorrect syntax near 'FORM'.")).message,
    "Incorrect syntax near 'FORM'."
  );
});

test("a batch mixing compile-time and runtime errors is redacted", () => {
  const error = sqlError(245, "Conversion failed when converting the varchar value 'Rossi' to data type int.", [
    { number: 207, message: "Invalid column name 'x'." }
  ]);
  assert.equal(isCompileTimeSqlError(error), false);
  assert.equal(sanitizeSqlErrorMessage(error).message.includes("Rossi"), false);

  const allCompile = sqlError(207, "Invalid column name 'y'.", [{ number: 207, message: "Invalid column name 'x'." }]);
  assert.equal(isCompileTimeSqlError(allCompile), true);
});

test("errors that do not come from SQL Server are left untouched", () => {
  const error = new Error('Target "prod-main" is not runtime-ready (stopped).');
  assert.deepEqual(sanitizeSqlErrorMessage(error), { message: error.message, redacted: false });
});
