/*
 * This module runs in the MAIN process and should at least contain your application specific SQL queries.
 * Just rename this file to `index.ts` and you're good to go.
 *
 * You may include additional custom logic that needs to run in the MAIN process, e.g. database related logic.
 * Using hooks it is possible to expose APIs to your RENDERER logic.
 */

// Load user configuration.
import { userConfig } from '.';
import { API } from '../preload';

import path from 'path';
import { exec, execSync } from 'child_process';

import * as hooks from '../inc/functions-hooks';

import StreamZip from 'node-stream-zip';

/**
 * This function is called from the MAIN process and PRELOAD script once.
 */
const initHooks = () =>
{
  // Filter both project- / and install number.
  hooks._addFilter('project_install_number', install_number => ((install_number ?? '') as string).trim());
  hooks._addFilter('project_project_number', project_number => ((project_number ?? '') as string).trim());

  // Filter description and customer name.
  hooks._addFilter('project_project_description', project_description => ((project_description ?? '') as string).trim());
  hooks._addFilter('project_install_description', install_description => ((install_description ?? '') as string).trim());
  hooks._addFilter('project_relation_name', relation_name => ((relation_name ?? '') as string).trim());

  /**
   * Return valid install path basenames for a given install number.
   */
  hooks._addFilter('install_path_basenames', (basenames: string[], number: ProjectAndInstallNumber) =>
  {
    return [
      hooks.applyFilters('project_project_number', number.install_number, { project_number: number.install_number }),
    ];
  });

  /**
   * Return valid project path basenames for a given project number.
   */
  hooks._addFilter('project_path_basenames', (basenames: string[], number: ProjectAndInstallNumber) =>
  {
    return [
      hooks.applyFilters('project_project_number', number.project_number, { project_number: number.project_number }),
    ];
  });

  /**
   * Determine if a path is a valid project path for a given project number.
   */
  hooks._addFilter('project_path_is_match', (_isMatch: boolean, potentialProjectPath: string, validProjectPathBasenames: string[]) =>
  {
    return validProjectPathBasenames.some(basename => path.basename(potentialProjectPath).endsWith(basename));
  });

  /**
   * Test if a dirname is a valid project folder location.
   */
  hooks._addFilter('is_valid_project_location', (_bool: boolean, lookupSubDir: string) =>
    /^\d{4}$/u.test(lookupSubDir));

  /**
   * Logic to create a project folder and return a `Promise<boolean>` whether the folder was created or not.
   */
  hooks._addFilter('create_project_folder', (_promise: Promise<boolean>, project: Project, projectPaths: ReturnType<Window['api']['project']['getProjectPaths']>) =>
  {
    // check permission first !!

    const project_number = hooks.applyFilters('project_project_number', project.project_number);

    const newLocation = API.project.getProjectPathLocations()
      .filter(lookupSubDir => lookupSubDir.slice(-2) === project_number.match(/\d{2}/u)[0])[0];

    const newProjectPath = path.join(newLocation, project_number);

    const buttons = [`Create "${newProjectPath}"`];

    projectPaths.installPaths.forEach(installPath =>
    {
      buttons.push(`Create in "${installPath}"`);
    });

    /**
     * Let the user decide what to do next.
     */
    return API.core.messageBox({
      type: 'warning',
      title: 'Create project folder',
      message: `Create a new project folder for "${project_number}":`,
      buttons: buttons.concat(['Cancel']),
    })
      .then(result =>
      {
        if (result.response === 0)
        {
          // Create new root project folder ..
        }
        else if (result.response < buttons.length)
        {
          const installPath = path.join(projectPaths.installPaths[result.response - 1]);

          // Create new project folder inside an existing install folder ..
        }

        // buttons.length equals 'Cancel'.
        return result.response !== buttons.length;
      });
  });

  /**
   * Filter the project price to allow for digit grouping and currency symbols.
   */
  hooks._addFilter('project_price', (price: number|string, project: Project) =>
  {
    return `€ ${
      price.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
  });

  /**
   * Static WHERE clause to fetch projects from the database.
   */
  hooks._addFilter('sql_where_get_projects', (query: string) =>
  {
    return query;
  });

  /**
   * SQL query to fetch multiple projects from the database.
   * The result is expected to be ordered descending by date by default.
   */
  hooks._addFilter('sql_get_projects', (query: string, args: getProjectArgs) =>
  {
    query += 'SELECT';

    if (!Array.isArray(args.search_for))
    {
      query += args.single
        ? ' TOP 1'
        : ` TOP ${userConfig.database.maxSelect}`;
    }

    // WHERE ..
    query += hooks.applyFilters('sql_where_get_projects');

    // project ID ..
    if (Array.isArray(args.project_ids))
    {
      query += `
    AND [projects].[id] IN (${args.project_ids.map(id => `'${API.sql.sanitizeSql(id.trim())}'`).join(', ')})`;
    }

    // project number ..
    else if (Array.isArray(args.project_numbers))
    {
      query += `
    AND upper(trim([projects].[project_number])) IN (${args.project_numbers.map(nr => `'${API.sql.sanitizeSql(nr.trim().toUpperCase())}'`).join(', ')})`;
    }

    // children of ..
    else if (!API.core.isEmpty(args.children_of))
    {
      const install_project = API.sql.sanitizeSql(args.children_of.trim().toUpperCase());

      query += `
    AND (
      upper(trim([projects].[project_number])) = '${install_project}'
      OR upper(trim([installations].[install_number])) LIKE '${hooks.applyFilters('project_project_number', install_project)}%'
    )`;
    }

    // deepsearch ..
    else if (Array.isArray(args.search_for))
    {
      if (args.search_for.length)
      {
        query += `
    AND (`;

        args.search_for.forEach((queryItem, index) =>
        {
          queryItem = API.sql.sanitizeSql(queryItem).toLowerCase();

          if (index > 0) query += `
      AND`;

          const negative = queryItem.startsWith('!');

          if (negative) queryItem = queryItem.substring(1);

          query += `
      (
        lower([projects].[project_number]) ${negative ? 'NOT ' : ''}LIKE '%${queryItem}%' ESCAPE '\\'
        ${negative ? 'AND' : 'OR'}
        lower([projects].[description]) ${negative ? 'NOT ' : ''}LIKE '%${queryItem}%' ESCAPE '\\' COLLATE Latin1_General_CI_AI
        ${negative ? 'AND' : 'OR'}
        lower([relations].[name]) ${negative ? 'NOT ' : ''}LIKE '%${queryItem}%' ESCAPE '\\' COLLATE Latin1_General_CI_AI
      )`;
        });

        query += `
    )`;
      }
    }

    // status ..
    else if (Array.isArray(args.status))
    {
      query += `
    AND [projects].[status] IN (${args.status.map(stat => `'${API.sql.sanitizeSql(stat.trim())}'`).join(', ')})`;
    }

    // order ..
    query += '\nORDER BY';
    query += args.orderBy !== 'DESC'
      ? `
    [date_start],
    [project_number],
    [install_number]`
      : `
    [date_start] DESC,
    [project_number] DESC,
    [install_number] DESC`;

    return query;
  });

  hooks._addFilter('sql_get_planning', (query: string, args: getPlanningArgs) =>
  {
    query += `SELECT
    * AS [task_id],
    * AS [parent_id],
    * AS [project_number],
    * AS [task_description],
    * AS [date_start],
    * AS [date_start_actual],
    * AS [date_finish],
    * AS [date_finish_actual],
    * AS [date_delivery]
  FROM
    *
  WHERE`;

    // project number ..
    query += API.core.isEmpty(args.project_number)
      ? `
    AND [planning].[project_number] IS NOT NULL`
      : `
    AND [planning].[project_number] = '${args.project_number}'`;

    // parent id ..
    query += API.core.isEmpty(args.parent_id)
      ? `
    AND [planning].[parent_id] IS NULL`
      : `
    AND [planning].[parent_id] = ${args.parent_id}`;

    // order ..
    query += '\nORDER BY';
    query += args.orderBy !== 'DESC'
      ? `
    [project_number],
    [date_start],
    [date_start_actual],
    [date_finish],
    [date_finish_actual],
    [date_delivery]`
      : `
    [project_number] DESC,
    [date_start] DESC,
    [date_start_actual] DESC,
    [date_finish] DESC,
    [date_finish_actual] DESC,
    [date_delivery] DESC`;

    return query;
  });

  /**
   * SQL query to fetch documents that are attached to a project.
   */
  hooks._addFilter('sql_get_attached_documents', (query: string, project: Project) =>
  {
    return query;
  });

  /**
   * SQL query to fetch resource hours worked on a project.
   */
  hooks._addFilter('sql_get_timesheets', (query: string, project: Project) =>
  {
    return query;
  });

  /**
   * Filter file icons.
   */
  hooks._addFilter('file_icon', (dataUrl: Promise<string>, filePath: string) =>
  {
    return dataUrl;
  });

  /**
   * Filter content of a file preview that is not supported by default.
   */
  hooks._addFilter('file_preview_content', (html: Promise<string>, filePath: string, extension: string) =>
  {
    return html;
  });
};

export default initHooks;