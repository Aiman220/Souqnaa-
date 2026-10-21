import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

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
   * Dynamically resolves the Python executable path across environments
   * (Docker, Linux production, Windows local, or custom env var).
   */
  getPythonExecutable(): string {
    if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
      return process.env.PYTHON_PATH;
    }

    if (process.platform === 'win32') {
      const localWinPath = 'C:\\Users\\Aiman\\python311\\python.exe';
      if (fs.existsSync(localWinPath)) {
        return localWinPath;
      }
      return 'python';
    }

    // Linux / MacOS / Docker container
    return 'python3';
  }

  /**
   * Spawns offline model training asynchronously without blocking the Node.js event loop.
   */
  async runOfflineTrainingScript(scriptName: string): Promise<boolean> {
    const pythonExe = this.getPythonExecutable();
    const trainingDir = path.resolve(process.cwd(), 'recommendations/training');
    const scriptPath = path.join(trainingDir, scriptName);

    if (!fs.existsSync(scriptPath)) {
      console.warn(`[PythonBridge] Training script not found at ${scriptPath}, skipping execution.`);
      return false;
    }

    console.log(`[PythonBridge] Starting offline training using '${pythonExe}': ${scriptPath}`);

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
