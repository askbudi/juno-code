/**
 * Tests for SystemInfoCollector utility class
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SystemInfoCollector,
  systemInfoCollector,
  collect,
  collectHardwareInfo,
  collectSoftwareInfo,
  collectNetworkInfo,
  collectPerformanceInfo,
  collectEnvironmentInfo,
  performHealthChecks,
  getSystemMetrics,
  type SystemInfo,
  type HardwareInfo,
  type SoftwareInfo,
  type NetworkInfo,
  type PerformanceInfo,
  type EnvironmentInfo,
  type HealthReport,
} from '../system-info.js';

describe('SystemInfoCollector', () => {
  let collector: SystemInfoCollector;

  beforeEach(() => {
    collector = new SystemInfoCollector();
  });

  describe('Constructor and Singleton', () => {
    it('should create instance', () => {
      const instance = new SystemInfoCollector();
      expect(instance).toBeInstanceOf(SystemInfoCollector);
    });

    it('should return singleton instance', () => {
      const instance1 = SystemInfoCollector.getInstance();
      const instance2 = SystemInfoCollector.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Hardware Information Collection', () => {
    it('should collect hardware information', async () => {
      const hardware = await collector.collectHardwareInfo();

      expect(hardware).toBeDefined();
      expect(hardware.cpu).toBeDefined();
      expect(hardware.memory).toBeDefined();
      expect(hardware.disk).toBeDefined();

      // CPU information
      expect(hardware.cpu.model).toBeDefined();
      expect(typeof hardware.cpu.cores).toBe('number');
      expect(hardware.cpu.cores).toBeGreaterThan(0);
      expect(typeof hardware.cpu.threads).toBe('number');
      expect(hardware.cpu.architecture).toBeDefined();

      // Memory information
      expect(typeof hardware.memory.total).toBe('number');
      expect(typeof hardware.memory.free).toBe('number');
      expect(typeof hardware.memory.used).toBe('number');
      expect(typeof hardware.memory.usedPercentage).toBe('number');
      expect(hardware.memory.total).toBeGreaterThan(0);
      expect(hardware.memory.usedPercentage).toBeGreaterThanOrEqual(0);
      expect(hardware.memory.usedPercentage).toBeLessThanOrEqual(100);

      // Disk information
      expect(Array.isArray(hardware.disk.drives)).toBe(true);
    });

    it('should calculate memory usage correctly', async () => {
      const hardware = await collector.collectHardwareInfo();

      const calculatedUsage = (hardware.memory.used / hardware.memory.total) * 100;
      expect(hardware.memory.usedPercentage).toBeCloseTo(calculatedUsage, 1);

      // Check that used + free approximately equals total (allow small variance due to memory changes)
      const sum = hardware.memory.used + hardware.memory.free;
      const difference = Math.abs(sum - hardware.memory.total);
      const tolerance = hardware.memory.total * 0.01; // 1% tolerance
      expect(difference).toBeLessThanOrEqual(tolerance);
    });

    it('should handle disk information gracefully', async () => {
      const hardware = await collector.collectHardwareInfo();

      hardware.disk.drives.forEach(drive => {
        expect(drive.mountpoint).toBeDefined();
        expect(typeof drive.total).toBe('number');
        expect(typeof drive.free).toBe('number');
        expect(typeof drive.used).toBe('number');
        expect(typeof drive.usedPercentage).toBe('number');
        expect(drive.usedPercentage).toBeGreaterThanOrEqual(0);
        expect(drive.usedPercentage).toBeLessThanOrEqual(100);
      });
    });
  });

  describe('Software Information Collection', () => {
    it('should collect software information', async () => {
      const software = await collector.collectSoftwareInfo();

      expect(software).toBeDefined();
      expect(software.os).toBeDefined();
      expect(software.runtime).toBeDefined();
      expect(software.installed).toBeDefined();

      // OS information
      expect(software.os.platform).toBeDefined();
      expect(software.os.version).toBeDefined();
      expect(software.os.release).toBeDefined();
      expect(software.os.architecture).toBeDefined();

      // Runtime information
      expect(software.runtime.node).toBeDefined();
      expect(software.runtime.node.version).toBeDefined();
      expect(software.runtime.node.v8Version).toBeDefined();

      // Installed software
      expect(Array.isArray(software.installed.compilers)).toBe(true);
      expect(Array.isArray(software.installed.tools)).toBe(true);
      expect(Array.isArray(software.installed.languages)).toBe(true);
    });

    it('should have valid Node.js runtime information', async () => {
      const software = await collector.collectSoftwareInfo();

      expect(software.runtime.node.version).toMatch(/^v\d+\.\d+\.\d+/);
      expect(software.runtime.node.v8Version).toBeDefined();
      expect(software.runtime.node.uvVersion).toBeDefined();
      expect(software.runtime.node.zlibVersion).toBeDefined();
      expect(software.runtime.node.opensslVersion).toBeDefined();
    });

    it('should collect installed software without errors', async () => {
      const software = await collector.collectSoftwareInfo();

      software.installed.compilers.forEach(compiler => {
        expect(compiler.name).toBeDefined();
        expect(compiler.version).toBeDefined();
        expect(compiler.path).toBeDefined();
      });

      software.installed.tools.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(tool.version).toBeDefined();
        expect(tool.path).toBeDefined();
      });

      software.installed.languages.forEach(lang => {
        expect(lang.name).toBeDefined();
        expect(lang.version).toBeDefined();
        expect(lang.path).toBeDefined();
      });
    });
  });

  describe('Network Information Collection', () => {
    it('should collect network information', async () => {
      const network = await collector.collectNetworkInfo();

      expect(network).toBeDefined();
      expect(network.interfaces).toBeDefined();
      expect(network.connectivity).toBeDefined();

      // Network interfaces
      expect(Array.isArray(network.interfaces)).toBe(true);
      expect(network.interfaces.length).toBeGreaterThan(0);

      network.interfaces.forEach(iface => {
        expect(iface.name).toBeDefined();
        expect(['ethernet', 'wifi', 'loopback', 'unknown']).toContain(iface.type);
        expect(Array.isArray(iface.addresses)).toBe(true);
        expect(['up', 'down', 'unknown']).toContain(iface.status);

        iface.addresses.forEach(addr => {
          expect(addr.address).toBeDefined();
          expect(['IPv4', 'IPv6']).toContain(addr.family);
          expect(typeof addr.internal).toBe('boolean');
        });
      });

      // Connectivity
      expect(typeof network.connectivity.internet).toBe('boolean');
      expect(typeof network.connectivity.dns).toBe('boolean');
    });

    it('should have at least one network interface', async () => {
      const network = await collector.collectNetworkInfo();

      expect(network.interfaces.length).toBeGreaterThan(0);

      // Should have at least loopback interface
      const loopbackExists = network.interfaces.some(iface =>
        iface.type === 'loopback' || iface.name.toLowerCase().includes('lo')
      );
      expect(loopbackExists).toBe(true);
    });
  });

  describe('Performance Information Collection', () => {
    it('should collect performance information', async () => {
      const performance = await collector.collectPerformanceInfo();

      expect(performance).toBeDefined();
      expect(performance.load).toBeDefined();
      expect(performance.uptime).toBeDefined();
      expect(performance.process).toBeDefined();

      // Load averages
      expect(typeof performance.load.one).toBe('number');
      expect(typeof performance.load.five).toBe('number');
      expect(typeof performance.load.fifteen).toBe('number');
      expect(performance.load.one).toBeGreaterThanOrEqual(0);
      expect(performance.load.five).toBeGreaterThanOrEqual(0);
      expect(performance.load.fifteen).toBeGreaterThanOrEqual(0);

      // Uptime
      expect(typeof performance.uptime).toBe('number');
      expect(performance.uptime).toBeGreaterThan(0);

      // Process information
      expect(typeof performance.process.pid).toBe('number');
      expect(performance.process.pid).toBeGreaterThan(0);
      expect(performance.process.memory).toBeDefined();
      expect(performance.process.cpu).toBeDefined();
      expect(typeof performance.process.uptime).toBe('number');
      expect(Array.isArray(performance.process.argv)).toBe(true);
      expect(performance.process.execPath).toBeDefined();
      expect(performance.process.cwd).toBeDefined();
    });

    it('should have valid process memory information', async () => {
      const performance = await collector.collectPerformanceInfo();

      const memory = performance.process.memory;
      expect(typeof memory.rss).toBe('number');
      expect(typeof memory.heapTotal).toBe('number');
      expect(typeof memory.heapUsed).toBe('number');
      expect(typeof memory.external).toBe('number');
      expect(typeof memory.arrayBuffers).toBe('number');

      expect(memory.rss).toBeGreaterThan(0);
      expect(memory.heapTotal).toBeGreaterThan(0);
      expect(memory.heapUsed).toBeGreaterThan(0);
      expect(memory.heapUsed).toBeLessThanOrEqual(memory.heapTotal);
    });

    it('should have valid CPU usage information', async () => {
      const performance = await collector.collectPerformanceInfo();

      const cpu = performance.process.cpu;
      expect(typeof cpu.user).toBe('number');
      expect(typeof cpu.system).toBe('number');
      expect(cpu.user).toBeGreaterThanOrEqual(0);
      expect(cpu.system).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Environment Information Collection', () => {
    it('should collect environment information', async () => {
      const environment = await collector.collectEnvironmentInfo();

      expect(environment).toBeDefined();
      expect(environment.user).toBeDefined();
      expect(environment.environment).toBeDefined();
      expect(environment.directories).toBeDefined();

      // User information
      expect(environment.user.username).toBeDefined();
      expect(environment.user.homedir).toBeDefined();

      // Environment variables
      expect(Array.isArray(environment.environment.path)).toBe(true);
      expect(environment.environment.path.length).toBeGreaterThan(0);
      expect(typeof environment.environment.variables).toBe('object');

      // Directories
      expect(environment.directories.home).toBeDefined();
      expect(environment.directories.tmp).toBeDefined();
      expect(environment.directories.cwd).toBeDefined();
    });

    it('should have valid path entries', async () => {
      const environment = await collector.collectEnvironmentInfo();

      environment.environment.path.forEach(pathEntry => {
        expect(typeof pathEntry).toBe('string');
        expect(pathEntry.length).toBeGreaterThan(0);
      });
    });

    it('should have accessible directories', async () => {
      const environment = await collector.collectEnvironmentInfo();

      expect(environment.directories.home).toBeDefined();
      expect(environment.directories.tmp).toBeDefined();
      expect(environment.directories.cwd).toBeDefined();

      // All directories should be absolute paths
      expect(environment.directories.home.startsWith('/')).toBe(true);
      expect(environment.directories.tmp.startsWith('/')).toBe(true);
      expect(environment.directories.cwd.startsWith('/')).toBe(true);
    });
  });

  describe('Complete System Information Collection', () => {
    it('should collect complete system information', async () => {
      const systemInfo = await collector.collect();

      expect(systemInfo).toBeDefined();
      expect(systemInfo.hardware).toBeDefined();
      expect(systemInfo.software).toBeDefined();
      expect(systemInfo.network).toBeDefined();
      expect(systemInfo.performance).toBeDefined();
      expect(systemInfo.environment).toBeDefined();
      expect(systemInfo.timestamp).toBeInstanceOf(Date);
      expect(systemInfo.collection).toBeDefined();

      // Collection metadata
      expect(typeof systemInfo.collection.duration).toBe('number');
      expect(systemInfo.collection.duration).toBeGreaterThan(0);
      expect(systemInfo.collection.version).toBeDefined();
      expect(Array.isArray(systemInfo.collection.errors)).toBe(true);
    });

    it('should complete collection within reasonable time', async () => {
      const startTime = Date.now();
      const systemInfo = await collector.collect();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(30000); // Should complete within 30 seconds
      expect(systemInfo.collection.duration).toBeCloseTo(duration, -2); // Within 100ms
    }, 60000); // Allow 60 seconds for test when running under resource contention
  });

  describe('Health Checks', () => {
    it('should perform system health checks', async () => {
      const healthReport = await collector.performHealthChecks();

      expect(healthReport).toBeDefined();
      expect(['healthy', 'warning', 'critical']).toContain(healthReport.overall);
      expect(Array.isArray(healthReport.checks)).toBe(true);
      expect(healthReport.checks.length).toBeGreaterThan(0);
      expect(typeof healthReport.score).toBe('number');
      expect(healthReport.score).toBeGreaterThanOrEqual(0);
      expect(healthReport.score).toBeLessThanOrEqual(100);
      expect(healthReport.timestamp).toBeInstanceOf(Date);
      expect(healthReport.summary).toBeDefined();

      // Summary counts
      expect(typeof healthReport.summary.healthy).toBe('number');
      expect(typeof healthReport.summary.warnings).toBe('number');
      expect(typeof healthReport.summary.critical).toBe('number');
      expect(healthReport.summary.healthy + healthReport.summary.warnings + healthReport.summary.critical)
        .toBe(healthReport.checks.length);
    });

    it('should have valid health check results', async () => {
      const healthReport = await collector.performHealthChecks();

      healthReport.checks.forEach(check => {
        expect(check.name).toBeDefined();
        expect(['healthy', 'warning', 'critical', 'unknown']).toContain(check.status);
        expect(check.message).toBeDefined();
        expect(typeof check.message).toBe('string');

        if (check.value !== undefined) {
          expect(typeof check.value).toBe('number');
        }
        if (check.threshold !== undefined) {
          expect(typeof check.threshold).toBe('number');
        }
      });
    });

    it('should calculate health score correctly', async () => {
      const healthReport = await collector.performHealthChecks();

      const expectedScore = (healthReport.summary.healthy / healthReport.checks.length) * 100;
      expect(healthReport.score).toBeCloseTo(expectedScore, 1);
    });
  });

  describe('System Metrics', () => {
    it('should get system metrics', async () => {
      const metrics = await collector.getSystemMetrics();

      expect(typeof metrics).toBe('object');
      expect(Object.keys(metrics).length).toBeGreaterThan(0);

      // Check for expected metric categories
      const expectedMetrics = [
        'cpu.cores',
        'memory.total',
        'memory.free',
        'memory.used',
        'memory.usage_percent',
        'process.memory.rss',
        'process.memory.heap_total',
        'process.memory.heap_used',
        'system.uptime',
        'process.uptime',
      ];

      expectedMetrics.forEach(metric => {
        expect(metrics[metric]).toBeDefined();
        expect(typeof metrics[metric]).toBe('number');
      });
    });

    it('should have reasonable metric values', async () => {
      const metrics = await collector.getSystemMetrics();

      // CPU cores should be positive
      expect(metrics['cpu.cores']).toBeGreaterThan(0);

      // Memory values should be positive
      expect(metrics['memory.total']).toBeGreaterThan(0);
      expect(metrics['memory.free']).toBeGreaterThanOrEqual(0);
      expect(metrics['memory.used']).toBeGreaterThanOrEqual(0);
      expect(metrics['memory.usage_percent']).toBeGreaterThanOrEqual(0);
      expect(metrics['memory.usage_percent']).toBeLessThanOrEqual(100);

      // Process memory should be positive
      expect(metrics['process.memory.rss']).toBeGreaterThan(0);
      expect(metrics['process.memory.heap_total']).toBeGreaterThan(0);
      expect(metrics['process.memory.heap_used']).toBeGreaterThan(0);

      // Uptime should be positive
      expect(metrics['system.uptime']).toBeGreaterThan(0);
      expect(metrics['process.uptime']).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle collection errors gracefully', async () => {
      // Test with a collector that might have limited permissions or missing tools
      // The collection should not throw but may include errors in the result
      try {
        const systemInfo = await collector.collect();
        expect(systemInfo).toBeDefined();
        expect(Array.isArray(systemInfo.collection.errors)).toBe(true);
        // Errors array might be empty or contain non-critical errors
      } catch (error) {
        // If collection fails completely, it should still provide meaningful error
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('System information collection failed');
      }
    });

    it('should handle individual collection failures', async () => {
      // Test individual collection methods
      const promises = [
        collector.collectHardwareInfo(),
        collector.collectSoftwareInfo(),
        collector.collectNetworkInfo(),
        collector.collectPerformanceInfo(),
        collector.collectEnvironmentInfo(),
      ];

      const results = await Promise.allSettled(promises);

      // At least some collections should succeed (performance and environment are most reliable)
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(0);
    });
  });

  describe('Convenience Functions', () => {
    it('should export convenience functions', () => {
      expect(typeof collect).toBe('function');
      expect(typeof collectHardwareInfo).toBe('function');
      expect(typeof collectSoftwareInfo).toBe('function');
      expect(typeof collectNetworkInfo).toBe('function');
      expect(typeof collectPerformanceInfo).toBe('function');
      expect(typeof collectEnvironmentInfo).toBe('function');
      expect(typeof performHealthChecks).toBe('function');
      expect(typeof getSystemMetrics).toBe('function');
    });

    it('should use default systemInfoCollector instance', async () => {
      const systemInfo = await collect();

      expect(systemInfo).toBeDefined();
      expect(systemInfo.hardware).toBeDefined();
      expect(systemInfo.software).toBeDefined();
      expect(systemInfo.network).toBeDefined();
      expect(systemInfo.performance).toBeDefined();
      expect(systemInfo.environment).toBeDefined();
    });

    it('should call individual collection functions', async () => {
      const [hardware, software, network, performance, environment] = await Promise.all([
        collectHardwareInfo(),
        collectSoftwareInfo(),
        collectNetworkInfo(),
        collectPerformanceInfo(),
        collectEnvironmentInfo(),
      ]);

      expect(hardware).toBeDefined();
      expect(software).toBeDefined();
      expect(network).toBeDefined();
      expect(performance).toBeDefined();
      expect(environment).toBeDefined();
    });
  });

  describe('Platform Compatibility', () => {
    it('should work on current platform', async () => {
      const systemInfo = await collector.collect();

      // Should successfully collect info regardless of platform
      expect(systemInfo.software.os.platform).toBeDefined();
      expect(['linux', 'darwin', 'win32', 'freebsd', 'openbsd']).toContain(systemInfo.software.os.platform);
    });

    it('should handle platform-specific features gracefully', async () => {
      const hardware = await collector.collectHardwareInfo();

      // Graphics info might not be available on all platforms
      if (hardware.graphics) {
        expect(Array.isArray(hardware.graphics.cards)).toBe(true);
      }

      // Disk info should be available on all platforms
      expect(Array.isArray(hardware.disk.drives)).toBe(true);
    });
  });
});