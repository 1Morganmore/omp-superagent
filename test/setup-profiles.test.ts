import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { REST, Routes, type RESTOptions } from "discord.js";
import { Api } from "grammy";
import type { Config } from "../src/config";
import { setupBotProfiles } from "../src/setup-profiles";

const image = readFileSync(new URL("../assets/superagent-avatar.jpg", import.meta.url));
const credentials = { DISCORD_PROFILE: "private-discord-profile-token", TELEGRAM_PROFILE: "900:private-telegram-profile-token" };
const config: Config = {
  path: "/unused/config.json", stateDir: "/unused/state", headCwd: "/unused",
  command: ["must-not-start"], maxHosts: 4, maxSubagents: 8, idleMs: 300000,
  discord: { tokenEnv: "DISCORD_PROFILE", ownerId: "42", allowedGuildIds: [], allowedChannelIds: [] },
  telegram: { tokenEnv: "TELEGRAM_PROFILE", ownerId: "42", allowedChatIds: [] },
};

function discordProfile(failure?: "identity" | "write" | "readback") {
  const calls: { method: string; body?: unknown }[] = [];
  let settings: Partial<RESTOptions> | undefined;
  let credential: string | undefined;
  const rest: Pick<REST, "get" | "patch"> = {
    async get(path) {
      expect(path).toBe(Routes.user("@me"));
      calls.push({ method: "get" });
      return { id: "900", bot: failure !== "identity", avatar: calls.length > 1
        ? failure === "readback" ? "wrong-avatar" : "new-avatar" : null };
    },
    async patch(path, options) {
      expect(path).toBe(Routes.user("@me"));
      calls.push({ method: "patch", body: options?.body });
      if (failure === "write") throw new Error(credentials.DISCORD_PROFILE);
      return { id: "900", bot: true, avatar: "new-avatar" };
    },
  };
  return {
    calls,
    get settings() { return settings; },
    get credential() { return credential; },
    createRest(options: Partial<RESTOptions>, token: string) { settings = options; credential = token; return rest; },
  };
}

function telegramProfile(failure?: "identity" | "write" | "receipt" | "readback") {
  const calls: { method: string; body: string; type: string }[] = [];
  let credential: string | undefined;
  const createApi = (token: string) => {
    credential = token;
    return new Api(token, {
      sensitiveLogs: false, baseFetchConfig: { redirect: "error" },
      fetch: (async (input, init) => {
        expect(init?.redirect).toBe("error");
        const method = String(input).split("/").at(-1)!;
        const body = await new Response(init?.body).text();
        calls.push({ method, body, type: new Headers(init?.headers).get("content-type") ?? "" });
        let result: unknown;
        if (method === "getMe") result = { id: 900, is_bot: failure !== "identity", first_name: "Bot" };
        else if (method === "setMyProfilePhoto") {
          if (failure === "write") throw new Error(`https://api.telegram.org/bot${token}/setMyProfilePhoto`);
          result = failure !== "receipt";
        } else if (method === "getUserProfilePhotos") result = failure === "readback"
          ? { total_count: 0, photos: [] }
          : { total_count: 1, photos: [[{ file_id: "new-file", file_unique_id: "new-unique", width: 1254, height: 1254 }]] };
        else throw new Error(`Forbidden Telegram API: ${method}`);
        return Response.json({ ok: true, result });
      }) as typeof fetch,
    });
  };
  return { calls, createApi, get credential() { return credential; } };
}

describe("setup mascot profiles", () => {
  test("sets both configured bot profiles with the repository JPEG and reads them back", async () => {
    const discord = discordProfile();
    const telegram = telegramProfile();
    const result = await setupBotProfiles(config, credentials, { createRest: discord.createRest, createApi: telegram.createApi });
    expect(result.map(row => [row.platform, row.status])).toEqual([["discord", "applied"], ["telegram", "applied"]]);
    expect(discord.credential).toBe(credentials.DISCORD_PROFILE);
    expect(telegram.credential).toBe(credentials.TELEGRAM_PROFILE);
    expect(discord.calls.map(call => call.method)).toEqual(["get", "patch", "get"]);
    expect(discord.calls[1]!.body).toEqual({ avatar: `data:image/jpeg;base64,${image.toString("base64")}` });
    expect(discord.settings?.retries).toBe(0);
    const reject = discord.settings?.rejectOnRateLimit;
    if (typeof reject !== "function") throw new Error("Missing rate-limit rejection");
    expect(await reject({} as Parameters<typeof reject>[0])).toBe(true);
    expect(telegram.calls.map(call => call.method)).toEqual(["getMe", "setMyProfilePhoto", "getUserProfilePhotos"]);
    const upload = telegram.calls[1]!;
    expect(upload.type).toContain("multipart/form-data");
    expect(upload.body).toContain('"type":"static"');
    expect(upload.body).toContain("attach://");
    expect(upload.body).toContain("filename=superagent-avatar.jpg");
    expect(upload.body).toContain("JFIF");
    expect(JSON.parse(telegram.calls[2]!.body)).toEqual({ user_id: 900, limit: 1 });
    expect(JSON.stringify(result)).not.toContain(credentials.DISCORD_PROFILE);
    expect(JSON.stringify(result)).not.toContain(credentials.TELEGRAM_PROFILE);
  });

  test.each(["identity", "write", "readback"] as const)("Discord %s failure is sanitized without retries and does not block Telegram", async failure => {
    const discord = discordProfile(failure);
    const telegram = telegramProfile();
    const result = await setupBotProfiles(config, credentials, { createRest: discord.createRest, createApi: telegram.createApi });
    expect(result.map(row => row.status)).toEqual(["failed", "applied"]);
    expect(discord.calls.filter(call => call.method === "patch")).toHaveLength(failure === "identity" ? 0 : 1);
    expect(result[0]!.message).toContain(failure === "identity" ? "no Discord profile update was attempted" : "unresolved");
    expect(JSON.stringify(result)).not.toContain(credentials.DISCORD_PROFILE);
  });

  test.each(["identity", "write", "receipt", "readback"] as const)("Telegram %s failure is sanitized without retries", async failure => {
    const telegram = telegramProfile(failure);
    const result = await setupBotProfiles({ ...config, discord: undefined }, credentials, { createApi: telegram.createApi });
    expect(result[0]!.status).toBe("failed");
    expect(telegram.calls.filter(call => call.method === "setMyProfilePhoto")).toHaveLength(failure === "identity" ? 0 : 1);
    expect(result[0]!.message).toContain(failure === "identity" ? "no Telegram profile update was attempted" : "unresolved");
    expect(JSON.stringify(result)).not.toContain(credentials.TELEGRAM_PROFILE);
    expect(JSON.stringify(result)).not.toContain("https://");
  });

  test("does not touch unconfigured platforms or accept missing credentials", async () => {
    const telegram = telegramProfile();
    const result = await setupBotProfiles({ ...config, discord: undefined }, credentials, {
      createApi: telegram.createApi, createRest() { throw new Error("Unconfigured Discord must not be used"); },
    });
    expect(result.map(row => row.platform)).toEqual(["telegram"]);
    const missing = await setupBotProfiles(config, {}, {
      createApi() { throw new Error("Missing token must not reach SDK"); },
      createRest() { throw new Error("Missing token must not reach SDK"); },
    });
    expect(missing.map(row => row.status)).toEqual(["failed", "failed"]);
  });

  test("cancellation during Discord prevents a subsequent Telegram mutation", async () => {
    const abort = new AbortController();
    const discord = discordProfile();
    const result = await setupBotProfiles(config, credentials, {
      signal: abort.signal,
      createRest(options, token) {
        const rest = discord.createRest(options, token);
        return { get: rest.get, async patch() { abort.abort(); throw new Error("Cancelled"); } };
      },
      createApi() { throw new Error("Cancelled setup must not reach Telegram"); },
    });
    expect(result.map(row => [row.platform, row.status])).toEqual([["discord", "failed"]]);
  });
});
