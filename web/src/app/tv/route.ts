// The address a TV opens (…/tv): on to the TV player, a plain page in public/tv.html that runs in any smart TV's own browser, old
// ones too (the One POS web app itself needs a modern browser). A relative address keeps the installation's prefix (/onepos).
export function GET() {
  return new Response(null, { status: 307, headers: { Location: "tv.html", "Cache-Control": "no-store" } });
}
