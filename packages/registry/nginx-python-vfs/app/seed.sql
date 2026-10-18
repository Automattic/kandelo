-- Sample rows inserted once, on first boot, when the table is empty.
INSERT INTO notes (title, body) VALUES
    ('Welcome to Kandelo',
     'This note is served by Python (wsgiref) behind nginx, all in WebAssembly.'),
    ('Try the API',
     'GET /api/notes, POST {"title","body"} to create, DELETE /api/notes/{id}.');
