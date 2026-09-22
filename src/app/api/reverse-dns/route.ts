import { reverseDnsLookup } from "@/lib/dns-resolver";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { ip } = await req.json();

  if (!ip || typeof ip !== "string") {
    return NextResponse.json({ error: "Invalid IP" }, { status: 400 });
  }

  const hostname = await reverseDnsLookup(ip);
  return NextResponse.json({ ip, hostname });
}
