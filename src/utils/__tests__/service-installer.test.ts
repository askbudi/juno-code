import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

// Helper to import ServiceInstaller with a mocked homedir pointing at a temp workspace
const loadInstallerWithTempHome = async (homeDir: string) => {
  vi.doMock('node:os', () => ({
    homedir: () => homeDir,
    default: { homedir: () => homeDir }
  }));
  const mod = await import('../service-installer.js');
  return mod.ServiceInstaller;
};

describe('ServiceInstaller', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-installer-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.remove(tempHome);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('installs all services and flags missing gemini for update', async () => {
    const ServiceInstaller = await loadInstallerWithTempHome(tempHome);

    // Use a copied package services directory that does not live under /src/ to avoid dev-only update behavior
    const packageServicesDir = path.join(tempHome, 'package-services');
    const sourceServicesDir = path.join(process.cwd(), 'src', 'templates', 'services');
    await fs.copy(sourceServicesDir, packageServicesDir);

    const packageSpy = vi.spyOn(ServiceInstaller as any, 'getPackageServicesDir').mockReturnValue(packageServicesDir);

    await ServiceInstaller.install(true);

    const servicesDir = ServiceInstaller.getServicesDir();
    const geminiPath = path.join(servicesDir, 'gemini.py');
    const codexPath = path.join(servicesDir, 'codex.py');
    const claudePath = path.join(servicesDir, 'claude.py');

    expect(await fs.pathExists(geminiPath)).toBe(true);
    expect(await fs.pathExists(codexPath)).toBe(true);
    expect(await fs.pathExists(claudePath)).toBe(true);

    // With all scripts present and matching package contents, no update should be needed
    expect(await ServiceInstaller.needsUpdate()).toBe(false);

    // Removing gemini.py should trigger an update requirement
    await fs.remove(geminiPath);
    expect(await ServiceInstaller.needsUpdate()).toBe(true);

    packageSpy.mockRestore();
  });
});
