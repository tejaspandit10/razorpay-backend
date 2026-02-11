import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: "postgresql://apcc_postgres_user:caZx32CSiJzmcuOFo3KroKKWhQGO7tAh@dpg-d65hj2q4d50c73c5c9og-a.oregon-postgres.render.com/apcc_postgres",
  },
});