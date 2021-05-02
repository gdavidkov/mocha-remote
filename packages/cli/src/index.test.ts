import cp from "child_process";
import path from "path";
import { expect } from "chai";

const cliPath = path.resolve(__dirname, "./index.ts");

function cli(...args: string[]) {
  return cp.spawnSync(
    process.execPath,
    ["--require", "ts-node/register", cliPath, ...args],
    { encoding: 'utf8' },
  );
}

function parseJsonOutput(output: string) {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
}

describe("Mocha Remote CLI", () => {
  it("prints --help", () => {
    const output = cli("--help");
    expect(output.stdout).contains("Show version number & exit");
  });

  it("run the command after -- and propagates exit status code", () => {
    const output = cli("--port", "0", "--", "node", "--eval", "\"console.log('hello!');process.exit(13);\"");
    expect(output.stdout).contains("hello!");
    expect(output.status).equals(13, "expected signal to propagate");
  });

  it("expose url, port and id as environment variables", () => {
    const output = cli("--port", "0", "--", "node", "--print", "\"JSON.stringify(process.env)\"");
    const jsonOuput = parseJsonOutput(output.stdout);
    expect(jsonOuput).include.keys("MOCHA_REMOTE_URL", "MOCHA_REMOTE_ID");
    const MOCHA_REMOTE_URL: string = jsonOuput.MOCHA_REMOTE_URL;
    const MOCHA_REMOTE_PORT: string = jsonOuput.MOCHA_REMOTE_PORT;
    const MOCHA_REMOTE_ID: string = jsonOuput.MOCHA_REMOTE_ID;
    expect(MOCHA_REMOTE_URL.startsWith("ws://0.0.0.0"));
    expect(Number.isInteger(MOCHA_REMOTE_PORT), "expected an integer port");
    expect(MOCHA_REMOTE_ID).equals("default");
  });

  it("propagates context to client", () => {
    // Supports multiple --context / -c runtime flags and multiple pairs in each
    // Using --silent to parse output of the command in isolation
    const output = cli("--port", "0", "--silent", "--context", "k1=v1,k2=v2", "-c", "k3=v3,truthy", "--", "ts-node", "src/test/context-logging-client.ts");
    const jsonOuput = parseJsonOutput(output.stdout);
    expect(jsonOuput).deep.equals({ k1: "v1", k2: "v2", k3: "v3", truthy: true });
  });

  it("prints when client connects", () => {
    const output = cli("--port", "0", "--", "ts-node", "src/test/simple-client.ts");
    expect(output.stdout).contains("CONNECTION from 127.0.0.1");
  });

  it("propagates failures as exit code", () => {
    const output = cli("--port", "0", "--context", "failure=Totally expected", "--", "ts-node", "src/test/simple-client.ts");
    expect(output.stdout).contains("Totally expected");
    expect(output.status).equals(1);
  });

  it("exits on error when asked", () => {
    const output = cli("--port", "0", "--exit-on-error", "--", "ts-node", "src/test/throwing-client.ts");
    expect(output.stderr).contains("ERROR b00m!");
    expect(output.status).equals(1);
  });

  it("greps tests", () => {
    const output = cli("--port", "0", "--grep", "not matching", "--", "ts-node", "src/test/simple-client.ts");
    expect(output.stdout).contains("0 passing");
    expect(output.status).equals(0);
  });

  it("greps tests inverted", () => {
    const output = cli("--port", "0", "--grep", "not matching", "--invert", "--", "ts-node", "src/test/simple-client.ts");
    expect(output.stdout).contains("1 passing");
    expect(output.status).equals(0);
  });

  it("allows re-running in watch mode", () => {
    const output = cli("--port", "0", "--watch", "--", "ts-node", "src/test/rerunning-client.ts");
    expect(output.stdout).contains("Running client #0");
    expect(output.stdout).contains("Running client #1");
    expect(output.stdout).contains("Running client #2");
    expect(output.status).equals(0);
  });
});
