-- ============================================================================
-- DayOne Pages — pastas de páginas (organização da tela /paginas)
--
-- Incremental e idempotente. Tudo no schema `pages`. Só o dashboard (service
-- key) lê e escreve; o servidor de entrega não sabe que pastas existem.
--
--   pages.folders           árvore de pastas (parent_id NULL = raiz), com cor
--   pages.pages.folder_id   em que pasta a página está (NULL = raiz)
--
-- Regras que o banco garante (a UI também, mas a UI não é a única porta):
--   - uma pasta não pode ser movida para dentro de si mesma / de uma descendente
--     (trigger pages.folders_no_cycle). Melhor esforço: o trigger olha a cadeia
--     de pais da linha alterada, sem lock; dois moves simultâneos em direções
--     opostas ainda poderiam se cruzar. A tela tolera ciclo (não trava, só
--     corta o caminho), então o risco é cosmético.
--   - profundidade máxima 20 contada até a pasta movida (a subárvore dela não
--     entra na conta; é um teto de sanidade, não uma garantia exata)
--   - excluir uma pasta NÃO apaga páginas: elas e as subpastas sobem para a
--     pasta-mãe (o dashboard faz isso antes do DELETE); se algo escapar,
--     ON DELETE SET NULL manda para a raiz em vez de falhar.
-- ============================================================================


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Tabela                                                                    │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS pages.folders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  parent_id   uuid        REFERENCES pages.folders(id) ON DELETE SET NULL,
  color       text,                       -- chave de cor da UI (ex.: 'blue'); NULL = padrão
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_folders_name  CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_folders_color CHECK (color IS NULL OR color ~ '^[a-z]{3,20}$')
);

COMMENT ON TABLE  pages.folders           IS 'Pastas (aninhadas) que organizam a tela de páginas do dashboard.';
COMMENT ON COLUMN pages.folders.parent_id IS 'Pasta-mãe; NULL = raiz.';
COMMENT ON COLUMN pages.folders.color     IS 'Chave da cor escolhida na UI; NULL = cor padrão.';

CREATE INDEX IF NOT EXISTS idx_pages_folders_parent ON pages.folders (parent_id);

ALTER TABLE pages.folders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pages.folders FROM anon, authenticated;

ALTER TABLE pages.pages
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES pages.folders(id) ON DELETE SET NULL;

COMMENT ON COLUMN pages.pages.folder_id IS 'Pasta da página na tela do dashboard; NULL = raiz.';

CREATE INDEX IF NOT EXISTS idx_pages_pages_folder ON pages.pages (folder_id);


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ updated_at                                                                │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION pages.folders_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_folders_touch_updated_at ON pages.folders;
CREATE TRIGGER trg_folders_touch_updated_at
  BEFORE UPDATE ON pages.folders
  FOR EACH ROW EXECUTE FUNCTION pages.folders_touch_updated_at();


-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ Sem ciclos, sem profundidade absurda                                      │
-- └──────────────────────────────────────────────────────────────────────────┘

CREATE OR REPLACE FUNCTION pages.folders_no_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cur   uuid := NEW.parent_id;
  depth int  := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'uma pasta não pode ficar dentro dela mesma' USING ERRCODE = 'check_violation';
  END IF;
  WHILE cur IS NOT NULL LOOP
    depth := depth + 1;
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'uma pasta não pode ficar dentro de uma subpasta dela' USING ERRCODE = 'check_violation';
    END IF;
    IF depth > 20 THEN
      RAISE EXCEPTION 'pastas aninhadas demais (máximo 20 níveis)' USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cur FROM pages.folders WHERE id = cur;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_folders_no_cycle ON pages.folders;
CREATE TRIGGER trg_folders_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON pages.folders
  FOR EACH ROW EXECUTE FUNCTION pages.folders_no_cycle();
