export class AppServerHostPool {
  constructor({ createConnection } = {}) {
    if (typeof createConnection !== 'function') throw new TypeError('createConnection is required.');
    this.createConnection = createConnection;
    this.connections = new Map();
  }

  connectionFor(host) {
    const hostId = String(host?.id || '');
    if (!hostId) throw new TypeError('host.id is required.');
    const current = this.connections.get(hostId);
    if (current && !['closed', 'stopped'].includes(current.state)) return current;
    const connection = this.createConnection(host);
    this.connections.set(hostId, connection);
    connection.once('exit', () => {
      if (this.connections.get(hostId) === connection) this.connections.delete(hostId);
    });
    return connection;
  }

  closeHost(hostId) {
    const key = String(hostId || '');
    const connection = this.connections.get(key);
    if (!connection) return;
    this.connections.delete(key);
    connection.close();
  }

  close() {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
