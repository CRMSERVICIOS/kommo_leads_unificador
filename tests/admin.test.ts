import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({ config: { adminToken: "" } }));

vi.mock("../src/config", () => ({ config: mocks.config }));

import { requireAdminToken } from "../src/routes/admin";

function run(authorization?: string) {
  const req = { header: () => authorization, path: "/unify-test", ip: "127.0.0.1" } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn() as NextFunction;
  requireAdminToken(req, res as unknown as Response, next);
  return { res, next };
}

beforeEach(() => {
  mocks.config.adminToken = "s3cret";
});

describe("requireAdminToken", () => {
  it("deja pasar con el Bearer correcto", () => {
    const { next, res } = run("Bearer s3cret");
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rechaza con 401 si el token no coincide o falta", () => {
    expect(run("Bearer otro").res.status).toHaveBeenCalledWith(401);
    expect(run(undefined).res.status).toHaveBeenCalledWith(401);
  });

  it("deshabilita /admin (503) si ADMIN_TOKEN no esta configurado", () => {
    mocks.config.adminToken = "";
    const { next, res } = run("Bearer ");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
