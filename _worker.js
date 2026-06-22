export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth') {
      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        scope: 'repo,user',
        redirect_uri: `${url.origin}/callback`,
      });
      return Response.redirect(
        `https://github.com/login/oauth/authorize?${params}`,
        302
      );
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (!code) {
        return new Response('Código OAuth ausente.', { status: 400 });
      }

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const { access_token, error } = await tokenRes.json();

      if (error || !access_token) {
        return new Response('Erro ao obter token do GitHub.', { status: 500 });
      }

      const content = JSON.stringify({ token: access_token, provider: 'github' });
      const html = `<!DOCTYPE html><html><body><script>
        (function(){
          function cb(e){
            window.opener.postMessage(
              'authorization:github:success:${content.replace(/'/g, "\\'")}',
              e.origin
            );
          }
          window.addEventListener('message', cb, false);
          window.opener.postMessage('authorizing:github', '*');
        })();
      </script></body></html>`;

      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    return env.ASSETS.fetch(request);
  },
};
