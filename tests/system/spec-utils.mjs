import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const resolveRoot = (...parts) => path.join(root, ...parts);
export const read = (file) => fs.readFileSync(file, 'utf8');
export const parse = (file) => JSON.parse(read(file));
export const clone = (value) => structuredClone(value);

export const compileSchema = (schema) => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const explain = () => ajv.errorsText(validate.errors, { separator: '\n' });
    return { validate, explain };
};
