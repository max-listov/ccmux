import { basename } from 'node:path';
import { CLIENT_NAME, type ClientArchive } from './control-client-archive.ts';

/** Install the exact release candidate by package name and version over npm's read protocol. */
export function serveClientCandidate(archive: ClientArchive) {
  const { version } = archive.manifest;
  const tarball = `/${CLIENT_NAME}/-/${basename(archive.path)}`;
  let downloads = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      if (request.method === 'GET' && path === tarball) {
        downloads++;
        return new Response(archive.bytes);
      }
      if (request.method === 'GET' && path === `/${CLIENT_NAME}`) {
        return Response.json({
          name: CLIENT_NAME,
          'dist-tags': { latest: version },
          versions: {
            [version]: {
              ...archive.manifest,
              dist: {
                tarball: new URL(tarball, url).href,
                integrity: archive.integrity,
              },
            },
          },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return { url: server.url, close: () => server.stop(true), downloads: () => downloads };
}
