import type { Service } from "@pulse/db";
import { validateTarget, type TargetPolicyOptions } from "@pulse/shared";
import { notFound, validationError } from "../../errors.js";
import { crossFieldIssues } from "./rules.js";
import type { CreateServiceInput, UpdateServiceInput } from "./schemas.js";
import type { ServicesRepository } from "./services.repository.js";

export class ServicesService {
  constructor(
    private readonly repo: ServicesRepository,
    /** SSRF policy configuration (allowPrivate comes from config, resolver is injectable). */
    private readonly targetPolicy: TargetPolicyOptions,
  ) {}

  list(ownerId: string, limit: number, offset: number) {
    return this.repo.list(ownerId, limit, offset);
  }

  async get(ownerId: string, id: string): Promise<Service> {
    const service = await this.repo.findOwned(ownerId, id);
    if (!service) throw notFound("Service");
    return service;
  }

  async create(ownerId: string, input: CreateServiceInput): Promise<Service> {
    // Rejects with TargetRejectedError before anything is stored.
    const target = await validateTarget(input.url, this.targetPolicy);
    return this.repo.create({ ...input, url: target.url.href, ownerId });
  }

  async update(ownerId: string, id: string, patch: UpdateServiceInput): Promise<Service> {
    const existing = await this.get(ownerId, id);

    const issues = crossFieldIssues({
      intervalSeconds: patch.intervalSeconds ?? existing.intervalSeconds,
      timeoutMs: patch.timeoutMs ?? existing.timeoutMs,
      expectedStatusMin: patch.expectedStatusMin ?? existing.expectedStatusMin,
      expectedStatusMax: patch.expectedStatusMax ?? existing.expectedStatusMax,
    });
    if (issues.length > 0) {
      throw validationError(issues.map((i) => ({ in: "body", path: i.path, message: i.message })));
    }

    const data: Parameters<ServicesRepository["updateOwned"]>[2] = { ...patch };
    if (patch.url !== undefined) {
      const target = await validateTarget(patch.url, this.targetPolicy);
      data.url = target.url.href;
      data.nextCheckAt = new Date(); // new endpoint: check it right away
    }

    const updated = await this.repo.updateOwned(ownerId, id, data);
    if (!updated) throw notFound("Service"); // deleted between the read and the write
    return updated;
  }

  async remove(ownerId: string, id: string): Promise<void> {
    if (!(await this.repo.deleteOwned(ownerId, id))) throw notFound("Service");
  }
}
