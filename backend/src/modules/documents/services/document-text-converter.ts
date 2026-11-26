import type { DocumentVersionRecord } from '../domain/document.js';

export type DocumentTextSegment = {
  text: string;
  page?: number;
  section?: string;
};

export type ConvertedDocumentText = {
  content: string;
  segments: DocumentTextSegment[];
  format: 'txt' | 'md' | 'pdf' | 'docx';
};

export interface DocumentTextConverter {
  convert(buffer: Buffer, version: DocumentVersionRecord): Promise<ConvertedDocumentText>;
}

export class LocalDocumentTextConverter implements DocumentTextConverter {
  async convert(buffer: Buffer, version: DocumentVersionRecord): Promise<ConvertedDocumentText> {
    const extension = version.fileName.split('.').pop()?.toLowerCase();

    if (extension === 'txt' || extension === 'md' || version.mimeType === 'text/plain' || version.mimeType === 'text/markdown') {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const content = extension === 'md' ? decoded.trim() : decoded;
      return {
        content,
        segments: [{ text: content, section: 'document' }],
        format: extension === 'md' ? 'md' : 'txt',
      };
    }

    if (extension === 'pdf' || version.mimeType === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const segments: DocumentTextSegment[] = result.pages
          .filter((page: { text: string }) => page.text.trim().length > 0)
          .map((page: { num: number; text: string }) => ({ text: page.text.trim(), page: page.num }));
        if (segments.length === 0) {
          throw new Error('PDF contained no extractable text.');
        }
        return {
          content: segments.map((segment: DocumentTextSegment) => segment.text).join('\n\n'),
          segments,
          format: 'pdf',
        };
      } finally {
        await parser.destroy();
      }
    }

    if (
      extension === 'docx'
      || version.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const content = result.value.trim();
      if (!content) {
        throw new Error('DOCX contained no extractable text.');
      }
      const paragraphs = content
        .split(/\n{2,}|\r\n\r\n/)
        .map((text) => text.trim())
        .filter(Boolean);
      return {
        content,
        segments: paragraphs.map((text, index) => ({ text, section: `paragraph-${index + 1}` })),
        format: 'docx',
      };
    }

    throw new Error('Unsupported document format. Only TXT, Markdown, PDF and DOCX conversion are supported.');
  }
}
