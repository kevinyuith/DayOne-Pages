import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession } from "@/lib/auth/cookie";
import { HOME_PATH, LOGIN_PATH, NEXT_PARAM, safeNextPath } from "@/lib/auth/routes";

/**
 * Proxy — a primeira tranca de rota.
 *
 * `proxy.ts`, não `middleware.ts`: o Next 16 renomeou a convenção e o arquivo
 * roda no runtime Node, o que permite `node:crypto` via cookie.ts. Não há
 * chamada de rede aqui: é um HMAC local, na casa dos microssegundos.
 *
 * O que ele faz: recusa credencial na query string, devolve 401 em `/api/*`
 * sem sessão, desvia o resto para `/login?next=`, e devolve quem já entrou
 * de `/login` para o destino. A segunda tranca é `requireSession()` no
 * layout e em cada action.
 */

/** Nomes que nunca podem chegar na query string (vazam em histórico, Referer e logs). */
const FORBIDDEN_PARAMS = /^(password|senha|passwd|pwd|pass|secret|segredo)$/i;

function passwordParam(url: URL): string | null {
  for (const name of url.searchParams.keys()) {
    if (FORBIDDEN_PARAMS.test(name)) return name;
  }
  return null;
}

const NO_STORE = { "Cache-Control": "private, no-store" };

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isLogin = pathname === LOGIN_PATH;

  // Recusa em vez de desviar: a URL suja já está no histórico. O que a recusa
  // garante é que a credencial nunca seja validada a partir de um parâmetro.
  const suspect = passwordParam(request.nextUrl);
  if (suspect !== null) {
    console.error(`[acesso] requisição recusada: parâmetro "${suspect}" na query string de ${pathname}. O valor não foi lido.`);
    return NextResponse.json({ error: "Requisição inválida." }, { status: 400, headers: NO_STORE });
  }

  const authenticated = isValidSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (!authenticated && !isLogin) {
    // Rota de API responde 401, não desvio: um redirect para HTML chegaria no
    // fetch como uma página de login com status 200.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Não autenticado." }, { status: 401, headers: NO_STORE });
    }
    const target = request.nextUrl.clone();
    target.pathname = LOGIN_PATH;
    target.search = "";
    target.searchParams.set(NEXT_PARAM, `${pathname}${search}`);
    return NextResponse.redirect(target);
  }

  if (authenticated && isLogin) {
    const back = safeNextPath(request.nextUrl.searchParams.get(NEXT_PARAM)) ?? HOME_PATH;
    const [path, query] = back.split("?");
    const target = request.nextUrl.clone();
    target.pathname = path;
    target.search = query ? `?${query}` : "";
    return NextResponse.redirect(target);
  }

  // Resposta que depende de cookie de sessão não pode ser guardada por CDN.
  const response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // Tudo, menos o que não é rota. `/api/` NÃO está excluído de propósito.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf)$).*)"],
};
