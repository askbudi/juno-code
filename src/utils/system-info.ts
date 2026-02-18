/**
 * SystemInfoCollector - Comprehensive system information collection utilities
 * for hardware detection, software inventory, and system health monitoring.
 */

import { cpus, freemem, totalmem, loadavg, uptime, userInfo, arch, platform, release, version, networkInterfaces, tmpdir } from 'os';
import { execSync } from 'child_process';
import fs from 'fs-extra';
import { join } from 'path';
import { CommandExecutor } from './command-executor.js';

/**
 * System hardware information
 */
export interface HardwareInfo {
  /** CPU information */
  cpu: {
    model: string;
    cores: number;
    threads: number;
    architecture: string;
    frequency?: number; // MHz
    cache?: {
      l1?: number;
      l2?: number;
      l3?: number;
    };
  };
  /** Memory information */
  memory: {
    total: number; // bytes
    free: number; // bytes
    used: number; // bytes
    usedPercentage: number;
    swap?: {
      total: number;
      free: number;
      used: number;
    };
  };
  /** Disk information */
  disk: {
    drives: Array<{
      mountpoint: string;
      filesystem: string;
      total: number;
      free: number;
      used: number;
      usedPercentage: number;
    }>;
  };
  /** Graphics information */
  graphics?: {
    cards: Array<{
      model: string;
      vendor: string;
      memory?: number;
    }>;
  };
}

/**
 * System software information
 */
export interface SoftwareInfo {
  /** Operating system information */
  os: {
    platform: string;
    distribution?: string;
    version: string;
    release: string;
    architecture: string;
    kernel?: string;
  };
  /** Runtime information */
  runtime: {
    node: {
      version: string;
      v8Version: string;
      uvVersion: string;
      zlibVersion: string;
      opensslVersion: string;
    };
    npm?: {
      version: string;
      prefix: string;
      registry: string;
    };
    yarn?: {
      version: string;
    };
    git?: {
      version: string;
      config: {
        user?: {
          name?: string;
          email?: string;
        };
      };
    };
  };
  /** Installed software */
  installed: {
    compilers: Array<{
      name: string;
      version: string;
      path: string;
    }>;
    tools: Array<{
      name: string;
      version: string;
      path: string;
    }>;
    languages: Array<{
      name: string;
      version: string;
      path: string;
    }>;
  };
}

/**
 * Network interface information
 */
export interface NetworkInfo {
  /** Network interfaces */
  interfaces: Array<{
    name: string;
    type: 'ethernet' | 'wifi' | 'loopback' | 'unknown';
    addresses: Array<{
      address: string;
      family: 'IPv4' | 'IPv6';
      internal: boolean;
      cidr?: string;
    }>;
    mac?: string;
    mtu?: number;
    speed?: number; // Mbps
    status: 'up' | 'down' | 'unknown';
  }>;
  /** Network connectivity */
  connectivity: {
    internet: boolean;
    dns: boolean;
    proxy?: {
      http?: string;
      https?: string;
      ftp?: string;
    };
  };
}

/**
 * System performance metrics
 */
export interface PerformanceInfo {
  /** CPU load averages */
  load: {
    one: number;
    five: number;
    fifteen: number;
  };
  /** System uptime */
  uptime: number; // seconds
  /** Process information */
  process: {
    pid: number;
    ppid?: number;
    memory: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
    cpu: {
      user: number;
      system: number;
    };
    uptime: number;
    argv: string[];
    execPath: string;
    cwd: string;
  };
}

/**
 * System environment information
 */
export interface EnvironmentInfo {
  /** User information */
  user: {
    username: string;
    uid?: number;
    gid?: number;
    homedir: string;
    shell?: string;
  };
  /** Environment variables */
  environment: {
    path: string[];
    locale?: string;
    timezone?: string;
    display?: string;
    terminal?: string;
    editor?: string;
    shell?: string;
    variables: Record<string, string>;
  };
  /** Directories */
  directories: {
    home: string;
    tmp: string;
    cwd: string;
    config?: string;
    data?: string;
    cache?: string;
  };
}

/**
 * Complete system information
 */
export interface SystemInfo {
  hardware: HardwareInfo;
  software: SoftwareInfo;
  network: NetworkInfo;
  performance: PerformanceInfo;
  environment: EnvironmentInfo;
  timestamp: Date;
  collection: {
    duration: number; // milliseconds
    version: string;
    errors: string[];
  };
}

/**
 * System health check result
 */
export interface HealthCheck {
  name: string;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  message: string;
  value?: number;
  threshold?: number;
  details?: Record<string, any>;
}

/**
 * System health report
 */
export interface HealthReport {
  overall: 'healthy' | 'warning' | 'critical';
  checks: HealthCheck[];
  score: number; // 0-100
  timestamp: Date;
  summary: {
    healthy: number;
    warnings: number;
    critical: number;
  };
}

/**
 * SystemInfoCollector class for comprehensive system information gathering
 */
export class SystemInfoCollector {
  private static instance: SystemInfoCollector;
  private commandExecutor: CommandExecutor;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly cacheTTL = 60000; // 1 minute cache

  constructor() {
    this.commandExecutor = CommandExecutor.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): SystemInfoCollector {
    if (!SystemInfoCollector.instance) {
      SystemInfoCollector.instance = new SystemInfoCollector();
    }
    return SystemInfoCollector.instance;
  }

  /**
   * Collect comprehensive system information
   */
  public async collect(): Promise<SystemInfo> {
    const startTime = Date.now();
    const errors: string[] = [];

    try {
      const [hardware, software, network, performance, environment] = await Promise.allSettled([
        this.collectHardwareInfo(),
        this.collectSoftwareInfo(),
        this.collectNetworkInfo(),
        this.collectPerformanceInfo(),
        this.collectEnvironmentInfo(),
      ]);

      return {
        hardware: this.unwrapResult(hardware, 'hardware', errors),
        software: this.unwrapResult(software, 'software', errors),
        network: this.unwrapResult(network, 'network', errors),
        performance: this.unwrapResult(performance, 'performance', errors),
        environment: this.unwrapResult(environment, 'environment', errors),
        timestamp: new Date(),
        collection: {
          duration: Date.now() - startTime,
          version: '1.0.0',
          errors,
        },
      };
    } catch (error) {
      errors.push(`Collection failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`System information collection failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Collect hardware information
   */
  public async collectHardwareInfo(): Promise<HardwareInfo> {
    const cpuInfo = cpus();
    const memTotal = totalmem();
    const memFree = freemem();
    const memUsed = memTotal - memFree;

    const hardware: HardwareInfo = {
      cpu: {
        model: cpuInfo[0]?.model || 'Unknown',
        cores: cpuInfo.length,
        threads: cpuInfo.length, // Node.js shows logical cores
        architecture: arch(),
        frequency: cpuInfo[0]?.speed,
      },
      memory: {
        total: memTotal,
        free: memFree,
        used: memUsed,
        usedPercentage: (memUsed / memTotal) * 100,
      },
      disk: {
        drives: await this.getDiskInfo(),
      },
    };

    // Add graphics info on platforms that support it
    try {
      hardware.graphics = await this.getGraphicsInfo();
    } catch {
      // Graphics info not available
    }

    return hardware;
  }

  /**
   * Collect software information
   */
  public async collectSoftwareInfo(): Promise<SoftwareInfo> {
    const software: SoftwareInfo = {
      os: {
        platform: platform(),
        version: release(),
        release: version(),
        architecture: arch(),
      },
      runtime: {
        node: {
          version: process.version,
          v8Version: process.versions.v8,
          uvVersion: process.versions.uv,
          zlibVersion: process.versions.zlib,
          opensslVersion: process.versions.openssl,
        },
      },
      installed: {
        compilers: [],
        tools: [],
        languages: [],
      },
    };

    // Add OS distribution info
    try {
      software.os.distribution = await this.getOSDistribution();
      software.os.kernel = await this.getKernelVersion();
    } catch {
      // Distribution info not available
    }

    // Collect runtime versions
    await Promise.allSettled([
      this.getNpmVersion().then(npm => { software.runtime.npm = npm; }),
      this.getYarnVersion().then(yarn => { software.runtime.yarn = yarn; }),
      this.getGitInfo().then(git => { software.runtime.git = git; }),
    ]);

    // Collect installed software
    await Promise.allSettled([
      this.getInstalledCompilers().then(compilers => { software.installed.compilers = compilers; }),
      this.getInstalledTools().then(tools => { software.installed.tools = tools; }),
      this.getInstalledLanguages().then(languages => { software.installed.languages = languages; }),
    ]);

    return software;
  }

  /**
   * Collect network information
   */
  public async collectNetworkInfo(): Promise<NetworkInfo> {
    const interfaces = networkInterfaces();
    const networkInfo: NetworkInfo = {
      interfaces: [],
      connectivity: {
        internet: false,
        dns: false,
      },
    };

    // Process network interfaces
    for (const [name, addresses] of Object.entries(interfaces)) {
      if (!addresses) continue;

      const interfaceInfo = {
        name,
        type: this.getInterfaceType(name),
        addresses: addresses.map(addr => ({
          address: addr.address,
          family: addr.family as 'IPv4' | 'IPv6',
          internal: addr.internal,
          cidr: addr.cidr,
        })),
        mac: addresses[0]?.mac,
        status: 'up' as const, // Assume up if in interface list
      };

      networkInfo.interfaces.push(interfaceInfo);
    }

    // Test connectivity
    try {
      networkInfo.connectivity = await this.testConnectivity();
    } catch {
      // Connectivity test failed
    }

    return networkInfo;
  }

  /**
   * Collect performance information
   */
  public async collectPerformanceInfo(): Promise<PerformanceInfo> {
    const load = loadavg();
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      load: {
        one: load[0],
        five: load[1],
        fifteen: load[2],
      },
      uptime: uptime(),
      process: {
        pid: process.pid,
        ppid: process.ppid,
        memory: {
          rss: memUsage.rss,
          heapTotal: memUsage.heapTotal,
          heapUsed: memUsage.heapUsed,
          external: memUsage.external,
          arrayBuffers: memUsage.arrayBuffers,
        },
        cpu: {
          user: cpuUsage.user / 1000, // microseconds to milliseconds
          system: cpuUsage.system / 1000,
        },
        uptime: process.uptime(),
        argv: process.argv,
        execPath: process.execPath,
        cwd: process.cwd(),
      },
    };
  }

  /**
   * Collect environment information
   */
  public async collectEnvironmentInfo(): Promise<EnvironmentInfo> {
    const user = userInfo();
    const env = process.env;

    return {
      user: {
        username: user.username,
        uid: user.uid,
        gid: user.gid,
        homedir: user.homedir,
        shell: user.shell,
      },
      environment: {
        path: (env.PATH || '').split(process.platform === 'win32' ? ';' : ':'),
        locale: env.LANG || env.LC_ALL,
        timezone: env.TZ,
        display: env.DISPLAY,
        terminal: env.TERM || env.TERM_PROGRAM,
        editor: env.EDITOR || env.VISUAL,
        shell: env.SHELL,
        variables: { ...env },
      },
      directories: {
        home: user.homedir,
        tmp: tmpdir(),
        cwd: process.cwd(),
        config: env.XDG_CONFIG_HOME || join(user.homedir, '.config'),
        data: env.XDG_DATA_HOME || join(user.homedir, '.local', 'share'),
        cache: env.XDG_CACHE_HOME || join(user.homedir, '.cache'),
      },
    };
  }

  /**
   * Perform system health checks
   */
  public async performHealthChecks(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];

    try {
      const [hardware, performance] = await Promise.all([
        this.collectHardwareInfo(),
        this.collectPerformanceInfo(),
      ]);

      // CPU load check
      checks.push(this.checkCPULoad(performance.load));

      // Memory usage check
      checks.push(this.checkMemoryUsage(hardware.memory));

      // Disk space check
      checks.push(this.checkDiskSpace(hardware.disk));

      // Process health check
      checks.push(this.checkProcessHealth(performance.process));

      // Network connectivity check
      try {
        const network = await this.collectNetworkInfo();
        checks.push(this.checkNetworkConnectivity(network.connectivity));
      } catch (error) {
        checks.push({
          name: 'Network Connectivity',
          status: 'critical',
          message: `Network check failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

    } catch (error) {
      checks.push({
        name: 'System Information Collection',
        status: 'critical',
        message: `Failed to collect system information: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Calculate overall health
    const summary = {
      healthy: checks.filter(c => c.status === 'healthy').length,
      warnings: checks.filter(c => c.status === 'warning').length,
      critical: checks.filter(c => c.status === 'critical').length,
    };

    const score = (summary.healthy / checks.length) * 100;
    const overall = summary.critical > 0 ? 'critical' : summary.warnings > 0 ? 'warning' : 'healthy';

    return {
      overall,
      checks,
      score,
      timestamp: new Date(),
      summary,
    };
  }

  /**
   * Get specific system metrics
   */
  public async getSystemMetrics(): Promise<Record<string, number>> {
    const [hardware, performance] = await Promise.all([
      this.collectHardwareInfo(),
      this.collectPerformanceInfo(),
    ]);

    return {
      'cpu.cores': hardware.cpu.cores,
      'cpu.frequency': hardware.cpu.frequency || 0,
      'cpu.load.1min': performance.load.one,
      'cpu.load.5min': performance.load.five,
      'cpu.load.15min': performance.load.fifteen,
      'memory.total': hardware.memory.total,
      'memory.free': hardware.memory.free,
      'memory.used': hardware.memory.used,
      'memory.usage_percent': hardware.memory.usedPercentage,
      'process.memory.rss': performance.process.memory.rss,
      'process.memory.heap_total': performance.process.memory.heapTotal,
      'process.memory.heap_used': performance.process.memory.heapUsed,
      'process.cpu.user': performance.process.cpu.user,
      'process.cpu.system': performance.process.cpu.system,
      'system.uptime': performance.uptime,
      'process.uptime': performance.process.uptime,
    };
  }

  // Private helper methods

  private async getDiskInfo(): Promise<HardwareInfo['disk']['drives']> {
    const drives: HardwareInfo['disk']['drives'] = [];

    try {
      if (process.platform === 'win32') {
        // Windows: Use WMIC or PowerShell
        const result = await this.commandExecutor.run('wmic', [
          'logicaldisk', 'get', 'size,freespace,caption', '/format:csv'
        ], { timeout: 5000 });

        if (result.success) {
          // Parse WMIC output
          const lines = result.stdout.split('\n').filter(line => line.trim() && !line.startsWith('Node'));
          for (const line of lines) {
            const parts = line.split(',').map(p => p.trim());
            if (parts.length >= 4) {
              const [, caption, freeSpace, size] = parts;
              const total = parseInt(size) || 0;
              const free = parseInt(freeSpace) || 0;
              const used = total - free;

              drives.push({
                mountpoint: caption,
                filesystem: 'NTFS', // Default assumption
                total,
                free,
                used,
                usedPercentage: total > 0 ? (used / total) * 100 : 0,
              });
            }
          }
        }
      } else {
        // Unix-like: Use df command
        const result = await this.commandExecutor.run('df', ['-B1'], { timeout: 5000 });

        if (result.success) {
          const lines = result.stdout.split('\n').slice(1); // Skip header
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 6) {
              const [filesystem, total, used, free, , mountpoint] = parts;
              const totalBytes = parseInt(total) || 0;
              const usedBytes = parseInt(used) || 0;
              const freeBytes = parseInt(free) || 0;

              drives.push({
                mountpoint,
                filesystem,
                total: totalBytes,
                free: freeBytes,
                used: usedBytes,
                usedPercentage: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
              });
            }
          }
        }
      }
    } catch (error) {
      // Fallback: at least try to get root filesystem info
      try {
        const stats = await fs.stat('/');
        drives.push({
          mountpoint: '/',
          filesystem: 'unknown',
          total: 0,
          free: 0,
          used: 0,
          usedPercentage: 0,
        });
      } catch {
        // No disk info available
      }
    }

    return drives;
  }

  private async getGraphicsInfo(): Promise<HardwareInfo['graphics']> {
    const cards: Array<{ model: string; vendor: string; memory?: number }> = [];

    try {
      if (process.platform === 'darwin') {
        // macOS: Use system_profiler
        const result = await this.commandExecutor.run('system_profiler', ['SPDisplaysDataType'], { timeout: 10000 });
        if (result.success) {
          // Parse macOS graphics info
          const lines = result.stdout.split('\n');
          let currentCard: any = null;

          for (const line of lines) {
            if (line.includes('Chipset Model:')) {
              if (currentCard) cards.push(currentCard);
              currentCard = {
                model: line.split(':')[1]?.trim() || 'Unknown',
                vendor: 'Unknown',
              };
            } else if (line.includes('Vendor:') && currentCard) {
              currentCard.vendor = line.split(':')[1]?.trim() || 'Unknown';
            }
          }
          if (currentCard) cards.push(currentCard);
        }
      } else if (process.platform === 'linux') {
        // Linux: Use lspci
        const result = await this.commandExecutor.run('lspci', ['-v'], { timeout: 5000 });
        if (result.success) {
          // Parse lspci output for VGA/3D controllers
          const vgaLines = result.stdout.split('\n').filter(line =>
            line.includes('VGA') || line.includes('3D') || line.includes('Display')
          );

          for (const line of vgaLines) {
            const parts = line.split(':');
            if (parts.length >= 3) {
              cards.push({
                model: parts[2]?.trim() || 'Unknown',
                vendor: parts[1]?.trim() || 'Unknown',
              });
            }
          }
        }
      }
    } catch {
      // Graphics info not available
    }

    return cards.length > 0 ? { cards } : undefined;
  }

  private async getOSDistribution(): Promise<string> {
    if (process.platform === 'linux') {
      try {
        const osRelease = await fs.readFile('/etc/os-release', 'utf8');
        const nameMatch = osRelease.match(/^NAME="?([^"\n]+)"?$/m);
        if (nameMatch) return nameMatch[1];
      } catch {
        // Try alternative methods
        try {
          const result = await this.commandExecutor.run('lsb_release', ['-d', '-s'], { timeout: 2000 });
          if (result.success) return result.stdout.trim().replace(/"/g, '');
        } catch {
          // Fallback to generic Linux
        }
      }
      return 'Linux';
    } else if (process.platform === 'darwin') {
      try {
        const result = await this.commandExecutor.run('sw_vers', ['-productName', '-productVersion'], { timeout: 2000 });
        if (result.success) {
          const lines = result.stdout.trim().split('\n');
          return lines.length >= 2 ? `${lines[0]} ${lines[1]}` : 'macOS';
        }
      } catch {
        // Fallback
      }
      return 'macOS';
    } else if (process.platform === 'win32') {
      try {
        const result = await this.commandExecutor.run('wmic', ['os', 'get', 'Caption', '/value'], { timeout: 5000 });
        if (result.success) {
          const captionMatch = result.stdout.match(/Caption=(.+)/);
          if (captionMatch) return captionMatch[1].trim();
        }
      } catch {
        // Fallback
      }
      return 'Windows';
    }

    return platform();
  }

  private async getKernelVersion(): Promise<string> {
    try {
      const result = await this.commandExecutor.run('uname', ['-r'], { timeout: 2000 });
      if (result.success) return result.stdout.trim();
    } catch {
      // Kernel version not available
    }
    return release();
  }

  private async getNpmVersion(): Promise<SoftwareInfo['runtime']['npm']> {
    try {
      const [versionResult, configResult] = await Promise.all([
        this.commandExecutor.run('npm', ['--version'], { timeout: 5000 }),
        this.commandExecutor.run('npm', ['config', 'get', 'prefix'], { timeout: 5000 }),
        this.commandExecutor.run('npm', ['config', 'get', 'registry'], { timeout: 5000 }),
      ]);

      return {
        version: versionResult.success ? versionResult.stdout.trim() : 'unknown',
        prefix: configResult.success ? configResult.stdout.trim() : 'unknown',
        registry: 'https://registry.npmjs.org/', // Default
      };
    } catch {
      return undefined;
    }
  }

  private async getYarnVersion(): Promise<SoftwareInfo['runtime']['yarn']> {
    try {
      const result = await this.commandExecutor.run('yarn', ['--version'], { timeout: 5000 });
      if (result.success) {
        return { version: result.stdout.trim() };
      }
    } catch {
      // Yarn not available
    }
    return undefined;
  }

  private async getGitInfo(): Promise<SoftwareInfo['runtime']['git']> {
    try {
      const [versionResult, nameResult, emailResult] = await Promise.all([
        this.commandExecutor.run('git', ['--version'], { timeout: 5000 }),
        this.commandExecutor.run('git', ['config', '--global', 'user.name'], { timeout: 5000 }),
        this.commandExecutor.run('git', ['config', '--global', 'user.email'], { timeout: 5000 }),
      ]);

      return {
        version: versionResult.success ? versionResult.stdout.replace('git version ', '').trim() : 'unknown',
        config: {
          user: {
            name: nameResult.success ? nameResult.stdout.trim() : undefined,
            email: emailResult.success ? emailResult.stdout.trim() : undefined,
          },
        },
      };
    } catch {
      return undefined;
    }
  }

  private async getInstalledCompilers(): Promise<Array<{ name: string; version: string; path: string }>> {
    const compilers: Array<{ name: string; version: string; path: string }> = [];
    const commonCompilers = ['gcc', 'clang', 'javac', 'rustc', 'go', 'tsc'];

    await Promise.allSettled(
      commonCompilers.map(async (compiler) => {
        try {
          const versionResult = await this.commandExecutor.run(compiler, ['--version'], { timeout: 3000 });
          const pathResult = await this.commandExecutor.validateCommand(compiler);

          if (versionResult.success && pathResult.exists) {
            compilers.push({
              name: compiler,
              version: versionResult.stdout.split('\n')[0] || 'unknown',
              path: pathResult.path || '',
            });
          }
        } catch {
          // Compiler not available
        }
      })
    );

    return compilers;
  }

  private async getInstalledTools(): Promise<Array<{ name: string; version: string; path: string }>> {
    const tools: Array<{ name: string; version: string; path: string }> = [];
    const commonTools = ['docker', 'kubectl', 'terraform', 'aws', 'gcloud', 'az'];

    await Promise.allSettled(
      commonTools.map(async (tool) => {
        try {
          const pathResult = await this.commandExecutor.validateCommand(tool);
          if (pathResult.exists) {
            tools.push({
              name: tool,
              version: pathResult.version || 'unknown',
              path: pathResult.path || '',
            });
          }
        } catch {
          // Tool not available
        }
      })
    );

    return tools;
  }

  private async getInstalledLanguages(): Promise<Array<{ name: string; version: string; path: string }>> {
    const languages: Array<{ name: string; version: string; path: string }> = [];
    const commonLanguages = ['python', 'python3', 'ruby', 'java', 'php', 'dotnet'];

    await Promise.allSettled(
      commonLanguages.map(async (lang) => {
        try {
          const versionResult = await this.commandExecutor.run(lang, ['--version'], { timeout: 3000 });
          const pathResult = await this.commandExecutor.validateCommand(lang);

          if (versionResult.success && pathResult.exists) {
            languages.push({
              name: lang,
              version: versionResult.stdout.split('\n')[0] || 'unknown',
              path: pathResult.path || '',
            });
          }
        } catch {
          // Language not available
        }
      })
    );

    return languages;
  }

  private getInterfaceType(name: string): 'ethernet' | 'wifi' | 'loopback' | 'unknown' {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('lo') || nameLower.includes('loopback')) return 'loopback';
    if (nameLower.includes('wi') || nameLower.includes('wlan') || nameLower.includes('airport')) return 'wifi';
    if (nameLower.includes('eth') || nameLower.includes('en')) return 'ethernet';
    return 'unknown';
  }

  private async testConnectivity(): Promise<NetworkInfo['connectivity']> {
    const connectivity = {
      internet: false,
      dns: false,
    };

    try {
      // Test DNS resolution
      const dnsResult = await this.commandExecutor.run('nslookup', ['google.com'], { timeout: 5000 });
      connectivity.dns = dnsResult.success;

      // Test internet connectivity
      const pingResult = await this.commandExecutor.run('ping', ['-c', '1', '8.8.8.8'], { timeout: 5000 });
      connectivity.internet = pingResult.success;
    } catch {
      // Connectivity tests failed
    }

    return connectivity;
  }

  private checkCPULoad(load: PerformanceInfo['load']): HealthCheck {
    const avgLoad = (load.one + load.five + load.fifteen) / 3;
    const cpuCores = cpus().length;
    const loadPerCore = avgLoad / cpuCores;

    if (loadPerCore > 0.8) {
      return {
        name: 'CPU Load',
        status: 'critical',
        message: `High CPU load: ${avgLoad.toFixed(2)} (${(loadPerCore * 100).toFixed(1)}% per core)`,
        value: loadPerCore,
        threshold: 0.8,
      };
    } else if (loadPerCore > 0.6) {
      return {
        name: 'CPU Load',
        status: 'warning',
        message: `Moderate CPU load: ${avgLoad.toFixed(2)} (${(loadPerCore * 100).toFixed(1)}% per core)`,
        value: loadPerCore,
        threshold: 0.6,
      };
    } else {
      return {
        name: 'CPU Load',
        status: 'healthy',
        message: `Normal CPU load: ${avgLoad.toFixed(2)} (${(loadPerCore * 100).toFixed(1)}% per core)`,
        value: loadPerCore,
      };
    }
  }

  private checkMemoryUsage(memory: HardwareInfo['memory']): HealthCheck {
    const usagePercent = memory.usedPercentage;

    if (usagePercent > 90) {
      return {
        name: 'Memory Usage',
        status: 'critical',
        message: `Very high memory usage: ${usagePercent.toFixed(1)}%`,
        value: usagePercent,
        threshold: 90,
      };
    } else if (usagePercent > 80) {
      return {
        name: 'Memory Usage',
        status: 'warning',
        message: `High memory usage: ${usagePercent.toFixed(1)}%`,
        value: usagePercent,
        threshold: 80,
      };
    } else {
      return {
        name: 'Memory Usage',
        status: 'healthy',
        message: `Normal memory usage: ${usagePercent.toFixed(1)}%`,
        value: usagePercent,
      };
    }
  }

  private checkDiskSpace(disk: HardwareInfo['disk']): HealthCheck {
    const criticalDrives = disk.drives.filter(drive => drive.usedPercentage > 95);
    const warningDrives = disk.drives.filter(drive => drive.usedPercentage > 85 && drive.usedPercentage <= 95);

    if (criticalDrives.length > 0) {
      return {
        name: 'Disk Space',
        status: 'critical',
        message: `Critical disk space on ${criticalDrives.map(d => `${d.mountpoint} (${d.usedPercentage.toFixed(1)}%)`).join(', ')}`,
        details: { criticalDrives },
      };
    } else if (warningDrives.length > 0) {
      return {
        name: 'Disk Space',
        status: 'warning',
        message: `Low disk space on ${warningDrives.map(d => `${d.mountpoint} (${d.usedPercentage.toFixed(1)}%)`).join(', ')}`,
        details: { warningDrives },
      };
    } else {
      return {
        name: 'Disk Space',
        status: 'healthy',
        message: 'Adequate disk space on all drives',
      };
    }
  }

  private checkProcessHealth(process: PerformanceInfo['process']): HealthCheck {
    const memoryMB = process.memory.rss / (1024 * 1024);

    if (memoryMB > 1000) {
      return {
        name: 'Process Health',
        status: 'warning',
        message: `High process memory usage: ${memoryMB.toFixed(1)} MB`,
        value: memoryMB,
        threshold: 1000,
      };
    } else {
      return {
        name: 'Process Health',
        status: 'healthy',
        message: `Normal process memory usage: ${memoryMB.toFixed(1)} MB`,
        value: memoryMB,
      };
    }
  }

  private checkNetworkConnectivity(connectivity: NetworkInfo['connectivity']): HealthCheck {
    if (!connectivity.internet) {
      return {
        name: 'Network Connectivity',
        status: 'critical',
        message: 'No internet connectivity detected',
        details: connectivity,
      };
    } else if (!connectivity.dns) {
      return {
        name: 'Network Connectivity',
        status: 'warning',
        message: 'Internet available but DNS resolution may be impaired',
        details: connectivity,
      };
    } else {
      return {
        name: 'Network Connectivity',
        status: 'healthy',
        message: 'Internet and DNS connectivity working normally',
        details: connectivity,
      };
    }
  }

  private unwrapResult<T>(result: PromiseSettledResult<T>, name: string, errors: string[]): T {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      const error = `${name} collection failed: ${result.reason}`;
      errors.push(error);
      throw new Error(error);
    }
  }

  private getCachedData<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
      return cached.data as T;
    }
    return null;
  }

  private setCachedData<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}

/**
 * Export default instance for convenience
 */
export const systemInfoCollector = SystemInfoCollector.getInstance();

/**
 * Convenience functions using default instance
 */
export const collect = () => systemInfoCollector.collect();
export const collectHardwareInfo = () => systemInfoCollector.collectHardwareInfo();
export const collectSoftwareInfo = () => systemInfoCollector.collectSoftwareInfo();
export const collectNetworkInfo = () => systemInfoCollector.collectNetworkInfo();
export const collectPerformanceInfo = () => systemInfoCollector.collectPerformanceInfo();
export const collectEnvironmentInfo = () => systemInfoCollector.collectEnvironmentInfo();
export const performHealthChecks = () => systemInfoCollector.performHealthChecks();
export const getSystemMetrics = () => systemInfoCollector.getSystemMetrics();