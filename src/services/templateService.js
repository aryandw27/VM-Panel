const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const https = require("https");
const config = require("../lib/config");
const logger = require("../lib/logger");
const { collections, settings, ensureConnected, getNextId } = require("../lib/db");

const DEFAULT_REPO_URL = "https://github.com/nobita329/Template.git";
const TEMPLATE_DIR = path.join(config.root, "storage/templates");
const REPO_DIR = path.join(TEMPLATE_DIR, "repo");

function execPromise(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, options, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || err.message));
      resolve(stdout.trim());
    });
  });
}

function fetchJsonUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "vPanel-Pro-TemplateSync/3.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJsonUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error("HTTP " + res.statusCode));
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

class TemplateService {
  constructor() {
    try {
      fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
    } catch (_) {}
  }

  getRepoUrl() {
    return settings.get("vm.template_repo") || DEFAULT_REPO_URL;
  }

  async setRepoUrl(url) {
    if (!url || typeof url !== "string") throw new Error("Invalid repository URL");
    await settings.set("vm.template_repo", url.trim());
    return this.getRepoUrl();
  }

  async syncTemplates(customUrl = null) {
    await ensureConnected();
    const repoUrl = customUrl ? customUrl.trim() : this.getRepoUrl();
    if (customUrl) {
      await this.setRepoUrl(repoUrl);
    }

    logger.info("[templateService] Syncing templates from: " + repoUrl);
    let imagesData = null;
    let syncMethod = "git";

    try {
      if (!fs.existsSync(REPO_DIR)) {
        await execPromise(`git clone --depth 1 "${repoUrl}" "${REPO_DIR}"`, { timeout: 60000 });
      } else {
        await execPromise(`git -C "${REPO_DIR}" pull --ff-only || git -C "${REPO_DIR}" fetch --depth 1 origin && git -C "${REPO_DIR}" reset --hard origin/HEAD`, { timeout: 60000 });
      }

      const jsonPath = path.join(REPO_DIR, "images.json");
      if (fs.existsSync(jsonPath)) {
        imagesData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      }
    } catch (gitErr) {
      logger.warn("[templateService] Git clone/pull failed, trying HTTP raw fallback: " + gitErr.message);
      
      try {
        const rawUrl = repoUrl
          .replace("https://github.com/", "https://raw.githubusercontent.com/")
          .replace(/\.git$/, "") + "/main/images.json";
        imagesData = await fetchJsonUrl(rawUrl);
        syncMethod = "raw-http";
      } catch (httpErr) {
        throw new Error("Failed to clone git repo and fallback raw download failed: " + gitErr.message + " / " + httpErr.message);
      }
    }

    if (!Array.isArray(imagesData)) {
      throw new Error("Invalid images.json format: expected an array of OS groups");
    }

    const syncedTemplates = [];
    const now = new Date().toISOString();

    for (const group of imagesData) {
      const groupName = group.name || "Unknown";
      const templates = Array.isArray(group.templates) ? group.templates : [];

      for (const t of templates) {
        if (!t.name || !t.vmid) continue;
        const vmid = Number(t.vmid);
        const filename = t.link ? path.basename(t.link.split("?")[0]) : "";

        const doc = {
          group: groupName,
          name: t.name,
          vmid: vmid,
          link: t.link || "",
          filename: filename,
          format: "vma.zst",
          status: "available",
          repo: repoUrl,
          updated_at: now,
        };

        await collections.templates.updateOne(
          { vmid: vmid },
          {
            $set: doc,
            $setOnInsert: {
              id: await getNextId("templates"),
              created_at: now,
            }
          },
          { upsert: true }
        );

        syncedTemplates.push(doc);
      }
    }

    logger.info(`[templateService] Synced ${syncedTemplates.length} templates across ${imagesData.length} groups`);

    return {
      ok: true,
      repo: repoUrl,
      count: syncedTemplates.length,
      groupsCount: imagesData.length,
      method: syncMethod,
      templates: syncedTemplates,
      synced_at: now,
    };
  }

  async listTemplates() {
    await ensureConnected();
    let templates = await collections.templates.find({}).sort({ group: 1, vmid: 1 }).toArray();
    if (!templates || templates.length === 0) {
      try {
        await this.syncTemplates();
        templates = await collections.templates.find({}).sort({ group: 1, vmid: 1 }).toArray();
      } catch (e) {
        logger.warn("[templateService] Auto-sync on list failed: " + e.message);
      }
    }
    return templates || [];
  }

  async getTemplatesGrouped() {
    const list = await this.listTemplates();
    const groups = {};
    for (const t of list) {
      const g = t.group || "Other";
      if (!groups[g]) groups[g] = [];
      groups[g].push(t);
    }
    return groups;
  }

  async getTemplateByVmid(vmid) {
    await ensureConnected();
    return collections.templates.findOne({ vmid: Number(vmid) });
  }

  async initDefaults() {
    try {
      const count = await collections.templates.countDocuments();
      if (count === 0) {
        logger.info("[templateService] No templates in database, starting initial sync from " + this.getRepoUrl());
        await this.syncTemplates();
      }
    } catch (e) {
      logger.warn("[templateService] initDefaults error: " + e.message);
    }
  }
}

module.exports = new TemplateService();
