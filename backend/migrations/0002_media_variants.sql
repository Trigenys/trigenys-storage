-- Client-uploaded resized renditions (",w320,w800"). Additive and nullable: existing rows stay valid.
ALTER TABLE media ADD COLUMN variants TEXT;
