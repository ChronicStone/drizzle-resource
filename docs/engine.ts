import { createQueryEngine } from "drizzle-resource";

import { db } from "./db";
import { relations } from "./relations";
import { schema } from "./schema";

export const engine = createQueryEngine({ db, schema, relations }).withContext<{
  isAdmin?: boolean;
  orgId: string;
  userId?: string;
}>();
