import { assertAppListener } from './daemon.mjs';
import { listTargets, isAppTarget } from './cdp.mjs';

export const DEFAULT_PORTS = [9341, 9342];

export function parsePorts(value) {
  const ports = value === undefined ? DEFAULT_PORTS : value.split(',').map(Number);
  if (!ports.length || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535)) {
    throw new Error('端口必须为 1024–65535，可用逗号分隔多个端口');
  }
  return [...new Set(ports)];
}

export async function endpointStatus(ports, { verify = assertAppListener, targets = listTargets } = {}) {
  return Promise.all(ports.map(async port => {
    try {
      await verify(port);
      const pages = (await targets(port)).filter(isAppTarget).length;
      return { port, connected: true, pages, error: null };
    } catch (error) {
      return { port, connected: false, pages: 0, error: error.code === 1 ? '等待客户端开启调试连接' : error.message };
    }
  }));
}
