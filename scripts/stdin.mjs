const MAX_STDIN_SIZE = 1_048_576;

export async function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding('utf8');
    let data = '';

    const timer = setTimeout(() => {
      cleanup();
      resolve(data ? safeParse(data) : {});
    }, timeoutMs);

    function onData(chunk) {
      data += chunk;

      if (data.length > MAX_STDIN_SIZE) {
        cleanup();
        process.stderr.write('[local-mem] stdin exceeded 1MB limit, truncating\n');
        resolve(safeParse(data.slice(0, MAX_STDIN_SIZE)));
        return;
      }

      try {
        const parsed = JSON.parse(data);
        cleanup();
        resolve(parsed);
      } catch { /* JSON incompleto, seguir leyendo */ }
    }

    function onError() { cleanup(); resolve({}); }

    function cleanup() {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
    }

    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
  });
}

function safeParse(str) {
  try { return JSON.parse(str); }
  catch { return {}; }
}
