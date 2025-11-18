import { CardFactory, TurnContext } from 'botbuilder';

export interface FormattedResult {
  text?: string;
  attachments?: any[];
}

export class ResultFormatter {
  private filesBaseUrl: string;

  constructor(filesBaseUrl: string = process.env.FILES_BASE_URL || 'https://files.mba-eng.com') {
    this.filesBaseUrl = filesBaseUrl;
  }

  async format(result: any, toolName: string): Promise<FormattedResult> {
    // Handle different result types
    if (result?.content && Array.isArray(result.content)) {
      return await this.formatContentArray(result.content, toolName);
    } else if (result?.downloadUrl || result?.filename) {
      return await this.formatFileResult(result);
    } else if (Array.isArray(result)) {
      return await this.formatTableResult(result);
    } else if (typeof result === 'string') {
      return await this.formatTextResult(result);
    } else if (typeof result === 'object') {
      return await this.formatObjectResult(result, toolName);
    }

    return { text: JSON.stringify(result) };
  }

  private async formatContentArray(content: any[], toolName: string): Promise<FormattedResult> {
    const formatted: FormattedResult = {
      text: '',
      attachments: [],
    };

    for (const item of content) {
      if (item.type === 'blob') {
        const fileCard = this.createFileCard(
          item.name || `file_${Date.now()}.pdf`,
          item.mimeType || 'application/pdf',
          item.data ? `data:${item.mimeType || 'application/pdf'};base64,${item.data}` : undefined,
          undefined,
          item.data ? Buffer.from(item.data, 'base64').length : undefined
        );
        formatted.attachments?.push(fileCard);
      } else if (item.type === 'text') {
        const text = typeof item.text === 'string' ? item.text : JSON.stringify(item.text);
        try {
          const parsed = JSON.parse(text);
          if (parsed.downloadUrl || parsed.filename) {
            const fileCard = this.createFileCard(
              parsed.filename || parsed.name || 'document',
              parsed.contentType || 'application/pdf',
              parsed.downloadUrl,
              parsed.message,
              parsed.size
            );
            formatted.attachments?.push(fileCard);
          } else if (typeof parsed === 'object' && parsed !== null) {
            // Format the parsed object using natural language formatter
            const objectFormatted = this.formatObjectResult(parsed, toolName);
            if (objectFormatted.text) {
              formatted.text += objectFormatted.text + '\n\n';
            }
            if (objectFormatted.attachments && objectFormatted.attachments.length > 0) {
              formatted.attachments?.push(...objectFormatted.attachments);
            }
          } else {
            formatted.text += text + '\n\n';
          }
        } catch {
          formatted.text += text + '\n\n';
        }
      }
    }

    return formatted;
  }

  private formatFileResult(result: any): FormattedResult {
    const card = this.createFileCard(
      result.filename || result.name || 'document',
      result.contentType || 'application/pdf',
      result.downloadUrl,
      result.message,
      result.size
    );

    return {
      attachments: [card],
    };
  }

  private formatTableResult(result: any[]): FormattedResult {
    if (result.length === 0) {
      return { text: 'No results found.' };
    }

    // Check if it's a table-like structure
    const firstItem = result[0];
    if (typeof firstItem === 'object' && firstItem !== null) {
      // Create a compact table representation
      const headers = Object.keys(firstItem);
      const maxRows = 50; // Increased from 20 to 50 to show more information
      const displayRows = result.slice(0, maxRows);

      let tableText = '```\n';
      // Header
      tableText += headers.join(' | ') + '\n';
      tableText += headers.map(() => '---').join(' | ') + '\n';

      // Rows
      for (const row of displayRows) {
        const values = headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          if (typeof val === 'object') return JSON.stringify(val).slice(0, 50); // Increased from 30 to 50
          return String(val).slice(0, 50); // Increased from 30 to 50
        });
        tableText += values.join(' | ') + '\n';
      }

      tableText += '```\n';

      if (result.length > maxRows) {
        tableText += `\n_Showing ${maxRows} of ${result.length} rows. Use /export for full CSV._`;
      }

      return { text: tableText };
    }

    // Simple list - increased from 50 to 100
    const listText = result.slice(0, 100).map((item, i) => `${i + 1}. ${String(item)}`).join('\n');
    if (result.length > 100) {
      return { text: listText + `\n\n_... and ${result.length - 100} more items_` };
    }
    return { text: listText };
  }

  private formatTextResult(result: string): FormattedResult {
    // Show more text - increased from 2000 to 5000 characters
    const maxLength = 5000;
    if (result.length > maxLength) {
      // Show first part and indicate truncation
      return {
        text: result.slice(0, maxLength) + `\n\n_... (truncated, ${result.length} characters total)_`,
      };
    }

    return { text: result };
  }

  private formatObjectResult(result: any, toolName: string): FormattedResult {
    // Format based on tool name and result structure
    // Check for address results (by tool name or result structure)
    if (result.address && (toolName.includes('address') || toolName.includes('client'))) {
      return this.formatAddressResult(result);
    }
    // Check for phone results (check if field exists, even if null)
    if (('phone_number' in result || 'phone' in result) && (toolName.includes('phone') || toolName.includes('client'))) {
      return this.formatPhoneResult(result);
    }
    // Check for email results
    if ((result.email || result.email_address) && (toolName.includes('email') || toolName.includes('client'))) {
      return this.formatEmailResult(result);
    }
    // For simple success responses, format naturally
    if (result.success !== undefined && Object.keys(result).length <= 5) {
      return this.formatSimpleResult(result, toolName);
    }

    // Fall back to JSON for complex objects
    const jsonStr = JSON.stringify(result, null, 2);
    const maxLength = 5000; // Increased from 2000 to 5000

    if (jsonStr.length > maxLength) {
      return {
        text: `\`\`\`json\n${jsonStr.slice(0, maxLength)}\n\`\`\`\n_... (truncated, ${jsonStr.length} characters total)_`,
      };
    }

    return {
      text: `\`\`\`json\n${jsonStr}\n\`\`\``,
    };
  }

  private formatAddressResult(result: any): FormattedResult {
    const address = result.address;
    if (typeof address === 'string') {
      // Clean up the address string (remove \r\n, normalize whitespace)
      const lines = address
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      let name = '';
      let addressLines: string[] = [];

      // Check if first line looks like a name (contains title like Ms., Mr., etc.)
      if (lines.length > 0 && /^(Ms\.|Mr\.|Mrs\.|Dr\.|Miss)\s/.test(lines[0])) {
        // Extract name without title
        name = lines[0].replace(/^(Ms\.|Mr\.|Mrs\.|Dr\.|Miss)\s+/, '');
        
        // Skip the first line (with title) and check if second line is duplicate name
        if (lines.length > 1 && lines[1] === name) {
          // Skip both name lines
          addressLines = lines.slice(2);
        } else {
          // Only skip the first line
          addressLines = lines.slice(1);
        }
      } else if (lines.length > 2 && lines[0] === lines[1]) {
        // If first two lines are identical, treat first as name
        name = lines[0];
        addressLines = lines.slice(2);
      } else {
        // No name detected, use all lines as address
        addressLines = lines;
      }

      let formattedText = '';
      if (name) {
        formattedText = `${name}'s address is:\n\n${addressLines.join('\n')}`;
      } else {
        formattedText = `Address:\n\n${addressLines.join('\n')}`;
      }

      return { text: formattedText };
    }

    // Fallback if address is not a string
    return { text: `Address: ${JSON.stringify(address)}` };
  }

  private formatPhoneResult(result: any): FormattedResult {
    const phone = result.phone_number ?? result.phone;
    const name = result.name || result.client_name || '';

    if (phone === null || phone === undefined) {
      if (name) {
        return { text: `${name} does not have a phone number on file.` };
      }
      return { text: `No phone number found.` };
    }

    if (name) {
      return { text: `${name}'s phone number is: ${phone}` };
    }
    return { text: `Phone number: ${phone}` };
  }

  private formatEmailResult(result: any): FormattedResult {
    const email = result.email || result.email_address;
    const name = result.name || result.client_name || '';

    if (name) {
      return { text: `${name}'s email address is: ${email}` };
    }
    return { text: `Email address: ${email}` };
  }

  private formatSimpleResult(result: any, toolName: string): FormattedResult {
    // For simple success responses, extract meaningful information
    const parts: string[] = [];

    // Skip 'success' field in natural language output
    if (result.success === true) {
      // Success is implied, don't mention it
    } else if (result.success === false) {
      parts.push('Operation failed.');
    }

    // Format other fields naturally
    for (const [key, value] of Object.entries(result)) {
      if (key === 'success') continue;

      if (key === 'message' && typeof value === 'string') {
        parts.push(value);
      } else if (key === 'error' && typeof value === 'string') {
        parts.push(`Error: ${value}`);
      } else if (value !== null && value !== undefined) {
        // Format key as readable label
        const label = key
          .replace(/_/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase());
        parts.push(`${label}: ${value}`);
      }
    }

    if (parts.length === 0) {
      return { text: 'Operation completed successfully.' };
    }

    return { text: parts.join('\n') };
  }

  private createFileCard(
    filename: string,
    contentType: string,
    downloadUrl?: string,
    message?: string,
    size?: number
  ): any {
    const sizeText = size ? this.formatFileSize(size) : '';

    return CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        ...(message
          ? [
              {
                type: 'TextBlock',
                text: message,
                size: 'Medium',
                weight: 'Bolder',
                wrap: true,
              },
            ]
          : []),
        {
          type: 'TextBlock',
          text: `**File:** ${filename}`,
          wrap: true,
          spacing: 'Small',
        },
        ...(sizeText
          ? [
              {
                type: 'TextBlock',
                text: `**Size:** ${sizeText}`,
                wrap: true,
                spacing: 'Small',
              },
            ]
          : []),
      ],
      actions: downloadUrl
        ? [
            {
              type: 'Action.OpenUrl',
              title: 'Download',
              url: downloadUrl,
            },
          ]
        : [],
    });
  }

  private summarizeText(text: string): string {
    // Simple summarization: extract more content - increased from 5 to 10 items
    const sentences = text.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
    const bullets = text.split(/\n[-*•]\s+/).filter(b => b.trim().length > 0);

    if (bullets.length >= 10) {
      return bullets.slice(0, 10).map(b => `• ${b.trim()}`).join('\n');
    } else if (sentences.length >= 10) {
      return sentences.slice(0, 10).join('. ') + '.';
    } else {
      return text.slice(0, 1000) + '...'; // Increased from 500 to 1000
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

