use std::io::{self, Read, Write};

use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use serde_json::Value;

const MAX_MESSAGE_SIZE: u32 = 1024 * 1024; // 1MB Chrome limit

pub fn read_message<R: Read>(reader: &mut R) -> io::Result<Option<Value>> {
    let len = match reader.read_u32::<LittleEndian>() {
        Ok(n) => n,
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    };

    if len > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
    }

    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;

    let value = serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(Some(value))
}

pub fn write_message<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    writer.write_u32::<LittleEndian>(bytes.len() as u32)?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn test_roundtrip() {
        let msg = json!({"type": "PING"});
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded = read_message(&mut cursor).unwrap().unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn test_eof_returns_none() {
        let mut cursor = Cursor::new(vec![]);
        let result = read_message(&mut cursor).unwrap();
        assert!(result.is_none());
    }
}
