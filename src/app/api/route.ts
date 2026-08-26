import { NextResponse } from "next/server";
import { log, requestContext } from '@/lib/logger';

export async function GET() {
  return NextResponse.json({ message: "Hello, world!" });
}