-- Habilita pgvector já no init para que migrações da Fase 2 só precisem CREATE TABLE.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
