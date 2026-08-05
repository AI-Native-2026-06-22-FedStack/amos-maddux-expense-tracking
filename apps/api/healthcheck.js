#!/usr/bin/env node
import http from "node:http";

const port = process.env.PORT ?? "3000";
const timeoutMs = 2_000;

const request = http.request(
  {
    host: "127.0.0.1",
    port,
    path: "/ready",
    method: "GET",
    timeout: timeoutMs
  },
  (response) => {
    response.resume();
    response.on("end", () => {
      process.exit(response.statusCode === 200 ? 0 : 1);
    });
  }
);

request.on("timeout", () => {
  request.destroy();
  process.exit(1);
});

request.on("error", () => {
  process.exit(1);
});

request.end();
