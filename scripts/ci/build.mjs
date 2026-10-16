import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const buildDir = resolve(root, process.argv[2] ?? 'build');
const oxcDir = resolve(buildDir, 'oxc-ci');
const windows = process.platform === 'win32';
const macos = process.platform === 'darwin';
const architecture = process.arch;

if ((windows || macos) && architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error(`Unsupported native architecture: ${process.platform}/${architecture}`);
}

function cmake(...args) {
    console.log('cmake', ...args);
    const result = spawnSync('cmake', args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`CMake failed (${result.status ?? result.signal})`);
}

const configure = ['-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'];
const native = ['-DCNO_RELEASE=ON', '-DCNO_BUNDLE_MINIFY=ON'];
if (windows) {
    native.push(`-DCMAKE_TOOLCHAIN_FILE=${root}/cmake/vcpkg-toolchain.cmake`,
        `-DVCPKG_TARGET_TRIPLET=${architecture}-windows`);
    if (architecture === 'arm64') {
        // WAMR's autodetection does not recognize Windows' uppercase ARM64.
        native.push('-DWAMR_BUILD_TARGET=AARCH64');
    }
}
if (macos) {
    configure.push(`-DCMAKE_OSX_ARCHITECTURES=${architecture === 'x64' ? 'x86_64' : architecture}`);
    if (process.env.CNO_CMAKE_PREFIX_PATH) {
        configure.push(`-DCMAKE_PREFIX_PATH=${process.env.CNO_CMAKE_PREFIX_PATH}`);
    }
}

cmake('-S', root, '-B', buildDir, ...configure, ...native);
cmake('--build', buildDir, '--config', 'Release', '--target', 'cno');

const extension = [`-DCJS_DIR=${root}/circu.js`];
if (windows) {
    extension.push(`-DCNO_IMPLIB=${buildDir}/circu.js/deps/quickjs/qjs.lib`);
}
cmake('-S', `${root}/scripts/ci/oxc`, '-B', oxcDir, ...configure, ...extension);
cmake('--build', oxcDir, '--config', 'Release');

const stage = resolve(buildDir, 'stage/ext');
mkdirSync(stage, { recursive: true });
// CMake MODULE libraries use .so on macOS; CTS looks for oxc.dylib.
copyFileSync(resolve(oxcDir, windows ? 'oxc.dll' : 'oxc.so'),
    resolve(stage, windows ? 'oxc.dll' : macos ? 'oxc.dylib' : 'oxc.so'));
