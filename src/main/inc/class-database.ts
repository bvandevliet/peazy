import { ConnectionConfig, Connection, Request as dbRequest, ColumnValue } from 'tedious';

/**
 * Core class used for default database interaction.
 */
export default class Database
{
  /**
   * The friendly name for this database connection.
   */
  public readonly _config: ConnectionConfig;

  private _isOpen = false;
  private _connection: Connection;

  /**
   *
   * @param config Connection configuration.
   */
  constructor (config: ConnectionConfig)
  {
    this._config = config;

    // Force using column names.
    this._config.options.useColumnNames = true;
  }

  /**
   * Get the `Connection` instance.
   */
  private getInstance (): Promise<Connection>
  {
    if (!this._isOpen || !(this._connection instanceof Connection))
    {
      try
      {
        this._connection?.cancel();
      }
      finally
      {
        this._connection?.removeAllListeners('end');
        this._connection?.close(); // triggers 'end'
      }

      this._connection = new Connection(this._config)
        .on('error', err => (this._isOpen = false, console.error(err)))
        .on('end', () => this._isOpen = false);

      return new Promise((resolve, reject) =>
      {
        this._connection.once('connect', err => err ? reject(err) : (this._isOpen = true, resolve(this._connection)));
      });
    }

    return new Promise(resolve => resolve(this._connection));
  }

  /**
   * Execute an SQL query.
   *
   * @param query Prepared SQL query to execute.
   * @param onRow Called on each returned row.
   */
  async execSql (query: string, onRow: (columns: Record<string, ColumnValue>) => void): Promise<number>
  {
    const connection = await this.getInstance();

    return new Promise((resolve, reject) =>
    {
      /*
       * Should actually be adding an overload to interface `Request` for the `row` event, in `@types/tedious` to allow for `config.options.useColumnNames` set to `true`.
       *
       * Overload would look like: `on(event: 'row', listener: (columns: Record<string, ColumnValue>) => void): this;`
       */
      const request = new dbRequest(query, (err, rowCount) => err ? reject(err) : resolve(rowCount)).on('row', onRow as any);

      connection.execSql(request);
    });
  }
}