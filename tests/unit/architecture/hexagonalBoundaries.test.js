import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '../../..');
const srcRoot = path.join(projectRoot, 'src');

const guardedRoots = [
  'application',
  'domain',
  'ports',
  'shared',
].map((directory) => path.join(srcRoot, directory));

const bannedInternalRoots = [
  'config',
  'controllers',
  'db',
  'infrastructure',
  'integrations',
  'lib',
  'middleware',
  'queues',
  'routes',
  'services',
  'tasks',
  'utils',
  'workers',
].map((directory) => path.join(srcRoot, directory));

const bannedPackages = new Set([
  'axios',
  'bullmq',
  'fastify',
  'ioredis',
  'mongoose',
  'redis',
]);

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listJavaScriptFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

function parseImportSpecifiers(source) {
  const imports = [];
  const importPattern = /import(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  let match = importPattern.exec(source);

  while (match) {
    imports.push(match[1]);
    match = importPattern.exec(source);
  }

  return imports;
}

function resolveImportPath(filePath, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }

  return path.resolve(path.dirname(filePath), specifier);
}

function isInsideDirectory(filePath, directory) {
  const relative = path.relative(directory, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('hexagonal architecture boundaries', () => {
  it('keeps HTTP route registration in the interfaces layer', () => {
    expect(fs.existsSync(path.join(srcRoot, 'routes'))).toBe(false);
  });

  it('does not expose debug or test HTTP routes', () => {
    const routeIndex = fs.readFileSync(
      path.join(srcRoot, 'interfaces', 'http', 'routes', 'index.js'),
      'utf8'
    );
    const bannedRouteNames = [
      'associationTest',
      'dbTest',
      'echo_test',
      'hubspotTest',
      'testHS',
    ];
    const existingDebugRouteFiles = [
      'associationTest.routes.js',
      'dbTest.routes.js',
      'echo.routes.js',
      'hubspotTest.routes.js',
      'testHS.routes.js',
    ].filter((fileName) =>
      fs.existsSync(path.join(srcRoot, 'interfaces', 'http', 'routes', fileName))
    );

    expect(existingDebugRouteFiles).toEqual([]);
    bannedRouteNames.forEach((routeName) => {
      expect(routeIndex).not.toContain(routeName);
    });
  });

  it('keeps active HTTP routes from importing legacy controllers', () => {
    const routeFiles = listJavaScriptFiles(path.join(srcRoot, 'interfaces', 'http', 'routes'));
    const violations = routeFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');

      return parseImportSpecifiers(source)
        .filter((specifier) => specifier.includes('/controllers/'))
        .map((specifier) => {
          const resolved = resolveImportPath(filePath, specifier);
          const legacyControllers = path.join(srcRoot, 'controllers');
          return resolved === legacyControllers || isInsideDirectory(resolved, legacyControllers)
            ? `${path.relative(projectRoot, filePath)} imports ${path.relative(projectRoot, resolved)}`
            : null;
        })
        .filter(Boolean);
    });

    expect(violations).toEqual([]);
  });

  it('keeps active HTTP controllers free of direct persistence/framework packages', () => {
    const controllerFiles = listJavaScriptFiles(path.join(srcRoot, 'interfaces', 'http', 'controllers'));
    const bannedControllerPackages = new Set(['mongoose', 'axios', 'bullmq', 'ioredis', 'redis']);
    const violations = controllerFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');

      return parseImportSpecifiers(source)
        .filter((specifier) => !specifier.startsWith('.'))
        .map((specifier) => {
          const packageName = specifier.split('/')[0];
          return bannedControllerPackages.has(packageName)
            ? `${path.relative(projectRoot, filePath)} imports package ${specifier}`
            : null;
        })
        .filter(Boolean);
    });

    expect(violations).toEqual([]);
  });

  it('keeps migrated webhook controller free of legacy adapters', () => {
    const filePath = path.join(srcRoot, 'interfaces', 'http', 'controllers', 'webhook.controller.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const legacyImports = parseImportSpecifiers(source).filter((specifier) =>
      [
        '/config/',
        '/queues/',
        '/services/',
        '/tasks/',
        '/utils/',
      ].some((legacySegment) => specifier.includes(legacySegment))
    );

    expect(legacyImports).toEqual([]);
  });

  it('keeps interface jobs from importing legacy services directly', () => {
    const jobFiles = listJavaScriptFiles(path.join(srcRoot, 'interfaces', 'jobs'));
    const violations = jobFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');

      return parseImportSpecifiers(source)
        .filter((specifier) =>
          [
            '/services/',
            '/tasks/',
            '/queues/',
            '/utils/',
          ].some((legacySegment) => specifier.includes(legacySegment))
        )
        .map((specifier) => `${path.relative(projectRoot, filePath)} imports ${specifier}`);
    });

    expect(violations).toEqual([]);
  });


  it('keeps domain, application, ports and shared independent from infrastructure and legacy modules', () => {
    const violations = guardedRoots
      .flatMap(listJavaScriptFiles)
      .flatMap((filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');

        return parseImportSpecifiers(source)
          .map((specifier) => {
            if (!specifier.startsWith('.')) {
              const packageName = specifier.split('/')[0];
              return bannedPackages.has(packageName)
                ? `${path.relative(projectRoot, filePath)} imports package ${specifier}`
                : null;
            }

            const resolved = resolveImportPath(filePath, specifier);
            const bannedRoot = bannedInternalRoots.find((directory) =>
              resolved === directory || isInsideDirectory(resolved, directory)
            );

            return bannedRoot
              ? `${path.relative(projectRoot, filePath)} imports ${path.relative(projectRoot, resolved)}`
              : null;
          })
          .filter(Boolean);
      });

    expect(violations).toEqual([]);
  });
});
