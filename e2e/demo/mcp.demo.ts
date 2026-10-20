// The MCP demo (docs/demo-mcp.gif): the user lets AI agents change the cluster with confirmation, an agent asks to
// scale a deployment, the user allows it in the window, and the call shows up in the activity log. The agent is a
// small MCP client in this file that introduces itself the way Claude Code does (clientInfo `claude-code`); the
// server, the access check, the confirmation and the log are the real ones. Recorded by scripts/demo-gif.sh.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { $, browser } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { byName, connectTo, eventually, openSection, row, searchTable, textOf } from "../app";
import { CONTEXT, NAMESPACE } from "../cluster";
import { HEIGHT, MCP_PORT, WIDTH, demoClick, startRecording, stopRecording } from "./helpers";

const DEPLOYMENT = "e2e-web";

interface RpcReply {
  id?: number;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
  error?: { message: string };
}

/** A minimal MCP client over Streamable HTTP: one session, requests answered as JSON or an event stream. */
class Agent {
  private session: string | null = null;
  private nextId = 0;

  constructor(private readonly token: string) {}

  private async post(body: object): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`MCP ${res.status}: ${await res.text()}`);
    this.session ??= res.headers.get("mcp-session-id");
    return res;
  }

  private async request(method: string, params: object): Promise<RpcReply> {
    const id = ++this.nextId;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const text = await res.text();
    const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter(Boolean)
          .map((data) => JSON.parse(data) as RpcReply)
      : [JSON.parse(text) as RpcReply];
    const reply = messages.find((m) => m.id === id);
    if (!reply) throw new Error(`no answer to ${method}`);
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.1.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Calls a tool; its JSON answer parsed, or the text as is. */
  async tool(name: string, args: object): Promise<unknown> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const text = reply.result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (reply.result?.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

function token(): string {
  const home = process.env.SEXTANT_E2E_HOME;
  if (!home) throw new Error("SEXTANT_E2E_HOME is not set");
  return readFileSync(path.join(home, "config", "dev.sextant.app", "mcp-token"), "utf8").trim();
}

describe("MCP demo", () => {
  let agent: Agent;
  let cluster = "";

  before(async () => {
    await browser.setWindowSize(WIDTH, HEIGHT);
    await connectTo(CONTEXT);
    await openSection("Deployments", "Workloads");
    await searchTable(DEPLOYMENT);
    await eventually(async () => (await textOf(row(DEPLOYMENT))).includes("1/1"), "the deployment at 1/1");

    // The server starts with the app; the token file appears once it runs.
    agent = await eventually(async () => {
      try {
        const a = new Agent(token());
        await a.initialize();
        return a;
      } catch {
        return null;
      }
    }, "the MCP server");
    const { clusters } = (await agent.tool("list_clusters", {})) as { clusters: { id: string; context: string }[] };
    const found = clusters.find((c) => c.context === CONTEXT);
    if (!found) throw new Error(`${CONTEXT} is not in list_clusters`);
    cluster = found.id;

    await browser.pause(800);
    startRecording();
    await browser.pause(400);
  });

  after(async () => {
    await stopRecording();
  });

  it("lets agents change the cluster, asking first", async () => {
    await demoClick(byName(CONTEXT, $('nav[aria-label="Clusters"]')), { button: "right", leave: true });
    const menu = $("[role='menu']");
    await menu.waitForDisplayed();
    await browser.pause(300);
    await demoClick(menu.$("[role='menuitem']=Settings"));

    // The cluster settings are in tabs (#230): agent access has its own.
    await demoClick($('[role="dialog"] [role="tab"]=AI agent access'));
    const section = $('section[aria-label="AI agent access"]');
    await section.waitForExist();
    await browser.pause(900);
    await demoClick(byName("Read + write (no delete)", section));
    await eventually(async () => (await textOf(section)).includes("It asks you first each time"), "the preset description");
    await browser.pause(2_000);
    await demoClick($('[role="dialog"] footer').$("button=Close"));
    await browser.pause(700);
  });

  it("an agent asks to scale a deployment and the user allows it", async () => {
    const scaled = agent.tool("scale", {
      cluster,
      kind: "Deployment",
      namespace: NAMESPACE,
      name: DEPLOYMENT,
      replicas: 3,
    });
    scaled.catch(() => undefined);

    const dialog = $('[role="alertdialog"]');
    await dialog.waitForDisplayed({ timeout: 30_000 });
    await browser.pause(2_800);
    await demoClick(dialog.$("button=Allow"));
    await scaled;
    await eventually(async () => (await textOf(row(DEPLOYMENT))).includes("3/3"), "the deployment at 3/3", 60_000);
    await browser.pause(1_800);
  });

  it("shows the call in the activity log", async () => {
    await demoClick($('button[aria-label^="Agent activity"]'), { leave: true });
    const log = $('[role="dialog"]');
    await eventually(async () => (await textOf(log)).includes("Approved by you"), "the approved call");
    await browser.pause(3_200);
  });
});
