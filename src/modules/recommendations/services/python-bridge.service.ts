import http from 'http';
import { spawn } from 'child_process';
import path from 'path';

export class PythonBridgeService {
  private static readonly PYTHON_SERVICE_PORT = 8008;
  private static readonly PYTHON_SERVICE_HOST = '127.0.0.1';

  /**
   * Check if Python FastAPI recommendation service is alive.
   */
  async isPythonServiceHealthy(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://${PythonBridgeService.PYTHON_SERVICE_HOST}:${PythonBridgeService.PYTHON_SERVICE_PORT}/health`,
        { timeout: 500 },
        (res) => {
          resolve(res.statusCode === 200);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Request LightFM/Collaborative inference from Python service.
   * If Python service is offline or errors, seamlessly returns empty list (triggers deterministic fallback).
   */
  async getPythonRecommendations(userId: string, limit = 20): Promise<Array<{ productId: string; score: number }>> {
    return new Promise((resolve) => {
      const postData = JSON.stringify({ userId, limit });
      const req = http.request(
        {
          hostname: PythonBridgeService.PYTHON_SERVICE_HOST,
          port: PythonBridgeService.PYTHON_SERVICE_PORT,
          path: '/recommendations/user',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 1000, // 1s max latency budget for ML inference
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(body);
                resolve(parsed.recommendations || []);
              } catch (_) {
                resolve([]);
              }
            } else {
              resolve([]);
            }
          });
        }
      );

      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        req.destroy();
        resolve([]);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Spawns offline model training asynchronously without blocking the Node.js event loop.
   */
  async runOfflineTrainingScript(scriptName: string): Promise<boolean> {
    const pythonExe = 'C:\\Users\\Aiman\\python311\\python.exe';
    const trainingDir = path.resolve(process.cwd(), 'recommendations/training');
    const scriptPath = path.join(trainingDir, scriptName);

    console.log(`[PythonBridge] Starting offline training: ${scriptPath}`);

    try {
      const child = spawn(pythonExe, [scriptPath], {
        cwd: trainingDir,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    } catch (err) {
      console.error(`[PythonBridge] Failed to launch ${scriptName}:`, err);
      return false;
    }
  }
}

export const pythonBridgeService = new PythonBridgeService();
