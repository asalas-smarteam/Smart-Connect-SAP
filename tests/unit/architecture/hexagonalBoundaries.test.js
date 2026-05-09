import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '../../..');
const srcRoot = path.join(projectRoot, 'src');

const hexagonalRoots = [
  'application',
  'bootstrap',
  'composition',
  'domain',
  'infrastructure',
  'interfaces',
  'main',
  'ports',
  'shared',
];

const guardedRoots = [
  'application',
  'domain',
  'ports',
  'shared',
].map((directory) => path.join(srcRoot, directory));

const removedLegacyRoots = [
  'config',
  'controllers',
  'core',
  'db',
  'integrations',
  'lib',
  'middleware',
  'queues',
  'routes',
  'services',
  'tasks',
  'utils',
  'workers',
];

const bannedInternalRoots = [
  'infrastructure',
  ...removedLegacyRoots,
].map((directory) => path.join(srcRoot, directory));

const bannedPackages = new Set([
  'axios',
  'bullmq',
  'fastify',
  'ioredis',
  'mongoose',
  'redis',
]);

const importAliasRoots = {
  '#application': 'application',
  '#bootstrap': 'bootstrap',
  '#composition': 'composition',
  '#domain': 'domain',
  '#infrastructure': 'infrastructure',
  '#interfaces': 'interfaces',
  '#main': 'main',
  '#ports': 'ports',
  '#shared': 'shared',
};

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
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(filePath), specifier);
  }

  const [alias, ...rest] = specifier.split('/');
  const root = importAliasRoots[alias];

  if (!root) {
    return null;
  }

  return path.join(srcRoot, root, ...rest);
}

function isInsideDirectory(filePath, directory) {
  const relative = path.relative(directory, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

describe('hexagonal architecture boundaries', () => {
  it('keeps every src JavaScript file under a hexagonal root', () => {
    const violations = listJavaScriptFiles(srcRoot)
      .map((filePath) => path.relative(srcRoot, filePath))
      .filter((relativePath) => !hexagonalRoots.includes(relativePath.split(path.sep)[0]));

    expect(violations).toEqual([]);
  });

  it('removes legacy implementation roots from src', () => {
    const existingRoots = removedLegacyRoots.filter((directory) =>
      fs.existsSync(path.join(srcRoot, directory))
    );

    expect(existingRoots).toEqual([]);
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

  it('keeps HTTP controllers from importing legacy implementation roots directly', () => {
    const controllerFiles = listJavaScriptFiles(path.join(srcRoot, 'interfaces', 'http', 'controllers'));
    const bannedRootsForControllers = [
      'config',
      'integrations',
      'lib',
      'queues',
      'services',
      'tasks',
      'utils',
      'workers',
    ].map((directory) => path.join(srcRoot, directory));
    const violations = controllerFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');

      return parseImportSpecifiers(source)
        .map((specifier) => {
          const resolved = resolveImportPath(filePath, specifier);
          if (!resolved) {
            return null;
          }

          const bannedRoot = bannedRootsForControllers.find((directory) =>
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
            if (!specifier.startsWith('.') && !specifier.startsWith('#')) {
              const packageName = specifier.split('/')[0];
              return bannedPackages.has(packageName)
                ? `${path.relative(projectRoot, filePath)} imports package ${specifier}`
                : null;
            }

            const resolved = resolveImportPath(filePath, specifier);
            if (!resolved) {
              return null;
            }
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
