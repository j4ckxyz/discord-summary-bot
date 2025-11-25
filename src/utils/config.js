import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const configPath = join(__dirname, '..', '..', 'config', 'config.json');
const exampleConfigPath = join(__dirname, '..', '..', 'config', 'config.example.json');

let configData;

try {
  if (existsSync(configPath)) {
    configData = JSON.parse(readFileSync(configPath, 'utf-8'));
  } else {
    // Use example config as fallback
    console.warn('config.json not found, using config.example.json');
    configData = JSON.parse(readFileSync(exampleConfigPath, 'utf-8'));
  }
} catch (error) {
  console.error('Error loading configuration:', error);
  process.exit(1);
}

export const config = configData;
