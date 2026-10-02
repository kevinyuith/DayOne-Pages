-- rule_move now swaps with the nearest rule OF THE SAME LABEL. The gate walks
-- the rules in two stages — Bot first, then Suspicious (server/src/rules.php
-- sorts by gate_label_rank before walking) — so order only matters within a
-- stage. Swapping across the Bot/Suspicious boundary changed the stored
-- position but never the walk, which looked like "reordering does nothing".

CREATE OR REPLACE FUNCTION pages.rule_move(p_id uuid, p_dir integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_pos int;
  v_label text;
  v_other uuid;
  v_other_pos int;
BEGIN
  SELECT r.position, r.label INTO v_pos, v_label FROM pages.rules r WHERE r.id = p_id FOR UPDATE;
  IF v_pos IS NULL THEN
    RAISE EXCEPTION 'rule_move: rule not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_dir < 0 THEN
    SELECT r.id, r.position INTO v_other, v_other_pos
    FROM pages.rules r WHERE r.label = v_label AND r.position < v_pos ORDER BY r.position DESC LIMIT 1;
  ELSE
    SELECT r.id, r.position INTO v_other, v_other_pos
    FROM pages.rules r WHERE r.label = v_label AND r.position > v_pos ORDER BY r.position LIMIT 1;
  END IF;
  IF v_other IS NULL THEN
    RETURN;
  END IF;
  UPDATE pages.rules r SET position = -1 WHERE r.id = p_id;
  UPDATE pages.rules r SET position = v_pos WHERE r.id = v_other;
  UPDATE pages.rules r SET position = v_other_pos WHERE r.id = p_id;
END $function$;
